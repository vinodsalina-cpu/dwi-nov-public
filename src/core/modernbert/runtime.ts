import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import type { EditRequest, EditSkillResult } from '../edit-contract';
import { compileEdits, decodeKeep, decodeOutcome, decodeSpans, envelope, insertionMeans, maxIndex, obligationFrame, spanMeans } from './decode';
import { maskedContext, prepareSource, type Recipe, type Tokenizer, unitRange, Unsupported } from './source';

// The runtime package's shared declarations also require browser globals.
type Tensor = { data: Float32Array | BigInt64Array; dims: readonly number[] };
type Session = {
	run(feeds: Record<string, Tensor>, fetches?: string[]): Promise<Record<string, Tensor>>;
	release(): Promise<void>;
};
type Ort = {
	Tensor: new (type: 'float32' | 'int64', data: Tensor['data'], dims: number[]) => Tensor;
	InferenceSession: { create(file: string, options: {
		executionProviders: ['cpu']; intraOpNumThreads: number; interOpNumThreads: number;
	}): Promise<Session> };
};

type Decoder = {
	recipe: Recipe & { feature_version: number; binary_gate: boolean; structured_spans: boolean; rewrite_refinement: boolean };
	width: number; bio_transitions: number[][][]; edit_transitions: number[][];
};

export async function openModernBert(bundle: string) {
	const load = createRequire(join(bundle, 'decoder.json'));
	const ort: Ort = load('onnxruntime-node');
	const { Tokenizer }: { Tokenizer: { fromFile(file: string): Promise<Tokenizer> } } = load('tokenizers');
	const config = JSON.parse(readFileSync(join(bundle, 'decoder.json'), 'utf8')) as Decoder;
	const { recipe, width } = config;
	if (recipe.feature_version !== 2 || !recipe.binary_gate || !recipe.structured_spans || !recipe.rewrite_refinement) {
		throw new Error('Unexpected ModernBERT ONNX recipe.');
	}
	const tokenizer = await Tokenizer.fromFile(join(bundle, 'tokenizer.json'));
	const tokenizerData = JSON.parse(readFileSync(join(bundle, 'tokenizer.json'), 'utf8')) as {
		added_tokens: Array<{ id: number; special: boolean; content: string }>;
	};
	const specialIds = new Set(tokenizerData.added_tokens.filter(token => token.special).map(token => token.id));
	const maskId = tokenizerData.added_tokens.find(token => token.special && token.content === '[MASK]')?.id;
	if (maskId === undefined) throw new Error('The tokenizer is missing the expected mask token.');
	const options = { executionProviders: ['cpu'] as ['cpu'], intraOpNumThreads: 2, interOpNumThreads: 1 };
	const sessions: Session[] = [];
	const open = async (name: string) => {
		const session = await ort.InferenceSession.create(join(bundle, name + '.onnx'), options);
		sessions.push(session);
		return session;
	};
	const dispose = () => Promise.allSettled(sessions.splice(0).map(session => session.release()));
	try {
		const encoder = await open('encoder'), planSession = await open('plan'), spanSession = await open('spans');
		const ints = (values: number[], dims: number[]) => new ort.Tensor('int64', BigInt64Array.from(values, BigInt), dims);
		const floats = (data: Float32Array, dims: number[]) => new ort.Tensor('float32', data, dims);
		const data = (tensor: Tensor) => {
			if (!(tensor.data instanceof Float32Array)) throw new Error('Expected FP32 inference output.');
			return tensor.data;
		};
		async function encode(ids: number[], positions: number[], context: Float32Array, output: 'hidden' | 'insertion_logits') {
			const result = await encoder.run({
				input_ids: ints(ids, [1, ids.length]), positions: ints(positions, [positions.length]),
				source_context: floats(context, [positions.length, width]),
			}, [output]);
			return result[output];
		}
		async function infer(request: EditRequest, parseOnly: boolean): Promise<EditSkillResult> {
			try {
				const item = await prepareSource(request, tokenizer, recipe);
				const count = item.units.length;
				const hidden = await encode(item.ids, [], new Float32Array(0), 'hidden');
				const plan = await planSession.run({
					hidden, pooling: floats(item.pooling, [count, item.ids.length]),
					coordinates: floats(item.coordinates, [count, 12]), unit_bytes: new ort.Tensor('int64', item.unitBytes, [count, item.byteWidth]),
				}, parseOnly ? ['units', 'roles'] : ['units', 'rewrite_units', 'roles', 'outcome', 'edit', 'length']);
				const spans = decodeSpans(data(plan.roles), count, config.bio_transitions, recipe.max_spans);
				const heads = await spanSession.run({
					means: floats(spanMeans(data(plan.units), spans, width), [spans.length, width]),
					role_ids: ints(spans.map(span => span.role), [spans.length]),
				});
				const frame = obligationFrame(item, spans, {
					relation: data(heads.relation), modality: data(heads.modality), question: data(heads.question),
				});
				const base = { ...envelope(request), obligations: frame };
				if (parseOnly) return { ...base, kind: 'unchanged' };
				const outcome = decodeOutcome(data(plan.outcome));
				if (outcome === 'needs-context' || frame.unresolved.length) {
					if (!frame.unresolved.length) throw new Unsupported('coverage', 'Clarification was predicted without a source-backed question.');
					return { ...base, kind: 'needs-context', questions: frame.unresolved };
				}
				if (outcome === 'unchanged') return { ...base, kind: 'unchanged' };
				const keep = decodeKeep(data(plan.edit), count, config.edit_transitions);
				const lengthClasses = recipe.max_insert_tokens + 1;
				const lengthScores = data(plan.length);
				const lengths = Array.from({ length: count + 1 }, (_, gap) => maxIndex(lengthScores, gap * lengthClasses, lengthClasses));
				for (const literal of request.source.protectedLiterals) {
					const [start, end] = unitRange(item, literal.range);
					if (keep.slice(start, end).some(Boolean) || lengths.slice(start + 1, end).some(Boolean)) {
						throw new Unsupported('coverage', 'The predicted plan would alter a protected source occurrence.');
					}
				}
				const fragments = lengths.map(() => '');
				if (lengths.some(Boolean)) {
					const masked = await maskedContext(item, keep, lengths, tokenizer, recipe, maskId!);
					const context = insertionMeans(data(plan.rewrite_units), keep, masked.owners, width);
					const output = await encode(masked.ids, masked.positions, context, 'insertion_logits');
					const vocabulary = output.dims[1];
					const logits = data(output);
					const tokens = masked.positions.map((_, i) => maxIndex(logits, i * vocabulary, vocabulary));
					if (output.dims[0] !== masked.positions.length || tokens.some(token => specialIds.has(token))) {
						throw new Unsupported('coverage', 'The insertion head predicted an invalid fragment.');
					}
					const gaps = new Map<number, number[]>();
					for (const [i, gap] of masked.owners.entries()) {
						const sequence = gaps.get(gap) ?? [];
						sequence.push(tokens[i]);
						gaps.set(gap, sequence);
					}
					for (const [gap, sequence] of gaps) {
						const fragment = await tokenizer.decode(sequence, false);
						const roundTrip = (await tokenizer.encode(fragment, null, { addSpecialTokens: false })).getIds();
						if (!fragment || sequence.length !== roundTrip.length || sequence.some((id, i) => id !== roundTrip[i])) {
							throw new Unsupported('coverage', 'An insertion does not round-trip through the tokenizer exactly.');
						}
						fragments[gap] = fragment;
					}
				}
				const edits = compileEdits(item, keep, fragments);
				return edits.length ? { ...base, kind: 'proposal', edits } : { ...base, kind: 'unchanged' };
			} catch (error) {
				if (error instanceof Unsupported) {
					return { ...envelope(request), kind: 'unsupported', reason: error.reason, message: error.message };
				}
				throw error;
			}
		}
		return { infer, dispose };
	} catch (error) {
		await dispose();
		throw error;
	}
}
