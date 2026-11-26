import type { EditRequest, SourceRange } from '../edit-contract';

// The pinned native binding's published declarations contain invalid TypeScript.
export type Tokenizer = {
	encode(text: string, pair: null, options: { addSpecialTokens: boolean }): Promise<{
		getIds(): number[]; getOffsets(): number[][];
	}>;
	decode(ids: number[], skipSpecialTokens: boolean): Promise<string>;
};

export type Recipe = Readonly<{
	max_tokens: number; max_spans: number; max_units: number; max_insert_tokens: number;
}>;
export type Prepared = ReturnType<typeof prepareUnits>;
export class Unsupported extends Error {
	constructor(readonly reason: 'coverage' | 'length', message: string) { super(message); }
}

function codePointOffsets(text: string) {
	if (/[\ud800-\udfff]/u.test(text)) {
		throw new Unsupported('coverage', 'Isolated Unicode surrogates are not supported by the tokenizer.');
	}
	const offsets = [0];
	for (const char of text) offsets.push(offsets[offsets.length - 1] + char.length);
	return offsets;
}

export async function encode(text: string, tokenizer: Tokenizer, recipe: Recipe) {
	const offsets = codePointOffsets(text);
	const encoded = await tokenizer.encode(text, null, { addSpecialTokens: true });
	const ids = encoded.getIds();
	if (ids.length > recipe.max_tokens) {
		throw new Unsupported('length', 'The complete request or insertion pass exceeds the configured token budget.');
	}
	const spans = encoded.getOffsets().map(([a, b]) => [offsets[a], offsets[b]] as const);
	return { ids, spans };
}

function prepareUnits(request: EditRequest, encoded: Awaited<ReturnType<typeof encode>>) {
	const { text, boundaries, protectedLiterals } = request.source;
	const units = boundaries.slice(1).map((b, i) => text.slice(boundaries[i].offset, b.offset));
	const positions = new Map(boundaries.map((b, i) => [b.id, i]));
	const literals = protectedLiterals.map(({ range }) => [boundaries[positions.get(range.start)!].offset,
		boundaries[positions.get(range.end)!].offset]);
	const usable = encoded.spans.flatMap(([a, b], i) => b > a ? [i] : []);
	if (!usable.length) throw new Unsupported('coverage', 'The tokenizer returned no source-aligned tokens.');
	const pooling = new Float32Array(units.length * encoded.ids.length);
	const coordinates = new Float32Array(units.length * 12);
	const bytes = units.map(unit => Buffer.from(unit));
	const byteWidth = bytes.reduce((size, unit) => Math.max(size, unit.length), 0);
	const unitBytes = new BigInt64Array(units.length * byteWidth);
	const isWord = units.map(unit => /[\p{L}\p{N}]/u.test(unit));
	for (const [row, unit] of units.entries()) {
		const { offset: a } = boundaries[row];
		const { offset: b } = boundaries[row + 1];
		const covering = usable.filter(i => encoded.spans[i][0] < b && encoded.spans[i][1] > a);
		if (!covering.length) {
			let nearest = usable[0], distance = Infinity;
			for (const i of usable) {
				const [left, right] = encoded.spans[i];
				const gap = Math.max(left - b, a - right, 0);
				if (gap < distance) { nearest = i; distance = gap; }
			}
			covering.push(nearest);
		}
		const [start, end] = encoded.spans[covering[0]];
		for (const i of covering) pooling[row * encoded.ids.length + i] = 1 / covering.length;
		coordinates.set([
			a / text.length, b / text.length, (a - start) / (end - start), (b - start) / (end - start),
			Number(/^[\p{White_Space}\u001c-\u001f]+$/u.test(unit)), Number(isWord[row]), Number(/^\p{P}+$/u.test(unit)),
			Number(a === Math.min(...covering.map(i => encoded.spans[i][0]))),
			Number(b === Math.max(...covering.map(i => encoded.spans[i][1]))),
			Number(isWord[row] && !isWord[row - 1]), Number(isWord[row] && !isWord[row + 1]),
			Number(literals.some(([left, right]) => left <= a && b <= right)),
		], row * 12);
		for (const [i, value] of bytes[row].entries()) unitBytes[row * byteWidth + i] = BigInt(value + 1);
	}
	return { request, units, positions, pooling, coordinates, unitBytes, byteWidth, ids: encoded.ids };
}

export async function prepareSource(request: EditRequest, tokenizer: Tokenizer, recipe: Recipe) {
	const { text, boundaries } = request.source;
	const validOffsets = new Set(codePointOffsets(text));
	if (!text || boundaries[0]?.offset !== 0 || boundaries.at(-1)?.offset !== text.length ||
		boundaries.some((b, i) => !validOffsets.has(b.offset) || (i > 0 && b.offset <= boundaries[i - 1].offset))) {
		throw new Unsupported('coverage', 'Source boundaries must cover a nonempty complete Unicode string.');
	}
	if (boundaries.length - 1 > recipe.max_units) {
		throw new Unsupported('length', 'Complete source exceeds the configured source-unit budget.');
	}
	return prepareUnits(request, await encode(text, tokenizer, recipe));
}

export function unitRange(item: Prepared, range: SourceRange): [number, number] {
	const start = item.positions.get(range.start), end = item.positions.get(range.end);
	if (start === undefined || end === undefined || start >= end) throw new Error('Invalid source range.');
	return [start, end];
}

export async function maskedContext(item: Prepared, keep: number[], lengths: number[],
	tokenizer: Tokenizer, recipe: Recipe, maskId: number) {
	let text = '';
	const slots: Array<{ start: number; end: number; gap: number }> = [];
	for (const [gap, length] of lengths.entries()) {
		if (length < 0 || length > recipe.max_insert_tokens) {
			throw new Unsupported('coverage', 'An insertion exceeds the trained gap-length vocabulary.');
		}
		for (let i = 0; i < length; i++) {
			const start = text.length;
			text += '[MASK]';
			slots.push({ start, end: text.length, gap });
		}
		if (keep[gap] === 0) text += item.units[gap];
	}
	const encoded = await encode(text, tokenizer, recipe);
	const positions = new Set<number>();
	for (const { start, end } of slots) {
		const matches = encoded.spans.flatMap(([a, b], i) => encoded.ids[i] === maskId && a <= start && b >= end ? [i] : []);
		if (matches.length !== 1 || positions.has(matches[0])) {
			throw new Unsupported('coverage', 'The tokenizer did not preserve inserted mask boundaries.');
		}
		positions.add(matches[0]);
	}
	return { ids: encoded.ids, positions: [...positions], owners: slots.map(slot => slot.gap) };
}
