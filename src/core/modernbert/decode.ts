import type { ContextQuestion, ObligationFrame, ObligationNode, RelationKind, SourceEdit } from '../edit-contract';
import { type Prepared, Unsupported } from './source';

const roles = ['action', 'target', 'condition', 'exception', 'scope', 'quantity', 'comparator', 'literal', 'unresolved'] as const;
const relations = ['target', 'condition', 'exception', 'scope', 'quantity', 'comparator', 'before', 'reference', 'same-node'] as const;
const modalities = ['required', 'permitted', 'prohibited', 'unspecified'] as const;
const questions = ['Which file or component is the target?', 'What scope should this request cover?',
	'Which condition must be satisfied?', 'What decision should be used here?', 'What does this reference refer to?'];
const outcomeNames = ['proposal', 'unchanged', 'needs-context'] as const;

export function maxIndex(values: ArrayLike<number>, offset = 0, count = values.length - offset) {
	let best = 0;
	for (let i = 1; i < count; i++) if (values[offset + i] > values[offset + best]) best = i;
	return best;
}

// The first winning state is significant when scores tie, as in PyTorch's argmax.
function decodeChain(emissions: Float32Array, units: number, stride: number, offset: number,
	transitions: number[][], bio = false) {
	const count = transitions.length;
	let scores = emissions.slice(offset, offset + count);
	if (bio) scores[2] = -10000;
	const back = new Uint8Array(units * count);
	for (let unit = 1; unit < units; unit++) {
		const nextScores = new Float32Array(count);
		for (let next = 0; next < count; next++) {
			let bestValue = -Infinity, bestState = 0;
			for (let prev = 0; prev < count; prev++) {
				const edge = bio && prev === 0 && next === 2 ? -10000 : transitions[prev][next];
				const value = Math.fround(scores[prev] + edge);
				if (value > bestValue) { bestValue = value; bestState = prev; }
			}
			back[unit * count + next] = bestState;
			nextScores[next] = bestValue + emissions[unit * stride + offset + next];
		}
		scores = nextScores;
	}
	const labels = Array<number>(units);
	labels[units - 1] = maxIndex(scores);
	for (let i = units - 1; i > 0; i--) labels[i - 1] = back[i * count + labels[i]];
	return labels;
}

export type Span = Readonly<{ start: number; end: number; role: number }>;
export function decodeSpans(emissions: Float32Array, units: number, transitions: number[][][], limit: number) {
	const spans: Span[] = [];
	for (let role = 0; role < roles.length; role++) {
		const labels = decodeChain(emissions, units, roles.length * 3, role * 3, transitions[role], true);
		let start = -1;
		for (let i = 0; i <= units; i++) {
			const tag = labels[i] ?? 0;
			if (start >= 0 && tag !== 2) { spans.push({ start, end: i, role }); start = -1; }
			if (tag === 1 || (tag === 2 && start < 0)) start = i;
		}
		if (spans.length > limit) throw new Unsupported('length', 'Predicted spans exceed the configured candidate budget.');
	}
	return spans;
}

export const decodeOutcome = (values: Float32Array) => outcomeNames[maxIndex(values)];
export const decodeKeep = (values: Float32Array, units: number, transitions: number[][]) =>
	decodeChain(values, units, 2, 0, transitions);

export function spanMeans(units: Float32Array, spans: readonly { start: number; end: number }[], width: number) {
	const means = new Float32Array(spans.length * width);
	for (const [i, { start, end }] of spans.entries()) {
		for (let j = 0; j < width; j++) {
			let sum = 0;
			for (let k = start; k < end; k++) sum += units[k * width + j];
			means[i * width + j] = sum / (end - start);
		}
	}
	return means;
}

export function insertionMeans(units: Float32Array, keep: number[], owners: number[], width: number) {
	return spanMeans(units, owners.map(gap => {
		let end = gap;
		while (keep[end] === 1) end++;
		return end > gap ? { start: gap, end } : { start: Math.max(0, gap - 1), end: Math.min(keep.length, gap + 1) };
	}), width);
}

export function envelope(request: Prepared['request']) {
	const { id, revision, digest } = request.source;
	return { schemaVersion: 1 as const, jobId: request.jobId, source: { id, revision, digest } };
}

type Heads = { relation: Float32Array; modality: Float32Array; question: Float32Array };
export function obligationFrame(item: Prepared, spans: Span[], heads: Heads): ObligationFrame {
	const parent = spans.map((_, i) => i);
	const root = (i: number) => { while (parent[i] !== i) i = parent[i]; return i; };
	const hasEdge = (a: number, b: number, kind: number) => {
		const logit = heads.relation[(a * spans.length + b) * relations.length + kind];
		return Math.fround(1 / (1 + Math.exp(-logit))) >= 0.5;
	};
	for (const [a, { role }] of spans.entries()) {
		for (let b = 0; b < a; b++) {
			if (role === spans[b].role && hasEdge(a, b, relations.length - 1) && hasEdge(b, a, relations.length - 1)) {
				parent[root(a)] = root(b);
			}
		}
	}
	const groups = new Map<number, number[]>();
	for (const i of parent.keys()) {
		const representative = root(i);
		let group = groups.get(representative);
		if (!group) { group = []; groups.set(representative, group); }
		group.push(i);
	}
	const nodes: ObligationNode[] = [];
	const unresolved: ContextQuestion[] = [];
	const memberIds = new Map<number, string>();
	const range = (start: number, end: number) => ({
		start: item.request.source.boundaries[start].id, end: item.request.source.boundaries[end].id,
	});
	function groupLabel(members: number[], head: Float32Array, classes: number) {
		const mean = Float32Array.from({ length: classes }, (_, c) =>
			members.reduce((sum, row) => sum + head[row * classes + c], 0) / members.length);
		return maxIndex(mean);
	}
	for (const group of groups.values()) {
		const role = roles[spans[group[0]].role];
		const evidence = group.map(i => range(spans[i].start, spans[i].end));
		if (role === 'unresolved') {
			unresolved.push({ id: 'q' + unresolved.length, evidence, question: questions[groupLabel(group, heads.question, questions.length)] });
		} else {
			const id = 'n' + nodes.length;
			const node: ObligationNode = role === 'action'
				? { id, role, evidence, modality: modalities[groupLabel(group, heads.modality, modalities.length)] }
				: { id, role, evidence };
			nodes.push(node);
			for (const i of group) memberIds.set(i, node.id);
		}
	}
	const edges = new Set<string>();
	for (const [a, from] of memberIds) {
		for (const [b, to] of memberIds) {
			if (from === to) continue;
			for (let kind = 0; kind < relations.length - 1; kind++) {
				if (hasEdge(a, b, kind)) edges.add(JSON.stringify([relations[kind], from, to]));
			}
		}
	}
	return { source: envelope(item.request).source, nodes, unresolved,
		relations: [...edges].sort().map((edge, i) => {
			const [kind, from, to] = JSON.parse(edge) as [RelationKind, string, string];
			return { id: 'r' + i, kind, from, to };
		}) };
}

export function compileEdits(item: Prepared, keep: number[], fragments: string[]) {
	const rebuilt = fragments.map((text, i) => text + (keep[i] === 0 ? item.units[i] : '')).join('');
	if (rebuilt === item.request.source.text) return [];
	const boundary = (i: number) => item.request.source.boundaries[i].id;
	const edits: SourceEdit[] = [];
	let i = 0, consumedGap = -1;
	while (i <= keep.length) {
		const id = 'e' + edits.length;
		if (keep[i] === 1) {
			const start = i;
			let text = consumedGap === i ? '' : fragments[i];
			while (keep[i] === 1) text += fragments[++i];
			const range = { start: boundary(start), end: boundary(i) };
			edits.push(text ? { id, kind: 'replace', range, content: [{ kind: 'text', text }] } : { id, kind: 'delete', range });
			consumedGap = i;
		} else {
			if (consumedGap !== i && fragments[i]) {
				edits.push({ id, kind: 'insert', at: boundary(i), content: [{ kind: 'text', text: fragments[i] }] });
			}
			i++;
		}
	}
	return edits;
}
