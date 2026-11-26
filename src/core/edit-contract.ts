import { createHash } from 'node:crypto';
import type { TextChange } from './request-review';

export type SourceRef = Readonly<{ id: string; revision: number; digest: string }>;
export type SourceRange = Readonly<{ start: string; end: string }>;
export type Utf16Range = Readonly<{ start: number; end: number }>;
export type LiteralKind = 'identifier' | 'path' | 'code' | 'literal';
export type SourceSnapshot = SourceRef & Readonly<{
	text: string;
	boundaries: readonly Readonly<{ id: string; offset: number }>[];
	protectedLiterals: readonly Readonly<{ id: string; kind: LiteralKind; range: SourceRange }>[];
}>;
export type SourceInput = Readonly<{
	id: string; revision: number; text: string;
	/** Optional host-selected subset of grapheme boundaries; must include both ends. */
	allowedOffsets?: readonly number[];
	protectedLiterals?: readonly (Utf16Range & Readonly<{ id: string; kind: LiteralKind }>)[];
}>;
export type EditRequest = Readonly<{ schemaVersion: 1; jobId: string; source: SourceSnapshot }>;

export type ObligationRole = 'action' | 'target' | 'condition' | 'exception' | 'scope' | 'quantity' | 'comparator' | 'literal';
export type Modality = 'required' | 'permitted' | 'prohibited' | 'unspecified';
export type ObligationNode = Readonly<{ id: string; evidence: readonly SourceRange[] }> & (
	Readonly<{ role: 'action'; modality: Modality }> |
	Readonly<{ role: Exclude<ObligationRole, 'action'> }>
);
export type RelationKind = 'target' | 'condition' | 'exception' | 'scope' | 'quantity' | 'comparator' | 'before' | 'reference';
export type ObligationRelation = Readonly<{ id: string; kind: RelationKind; from: string; to: string }>;
export type ContextQuestion = Readonly<{ id: string; question: string; evidence: readonly SourceRange[] }>;
export type ObligationFrame = Readonly<{
	source: SourceRef; nodes: readonly ObligationNode[];
	relations: readonly ObligationRelation[]; unresolved: readonly ContextQuestion[];
}>;

export type EditPiece = Readonly<{ kind: 'text'; text: string }> | Readonly<{ kind: 'copy'; range: SourceRange }>;
export type SourceEdit = Readonly<{ id: string }> & (
	Readonly<{ kind: 'insert'; at: string; content: readonly EditPiece[] }> |
	Readonly<{ kind: 'replace'; range: SourceRange; content: readonly EditPiece[] }> |
	Readonly<{ kind: 'delete'; range: SourceRange }>
);
type ResultEnvelope = Readonly<{ schemaVersion: 1; jobId: string; source: SourceRef; obligations?: ObligationFrame }>;
export type EditSkillResult = ResultEnvelope & (
	Readonly<{ kind: 'proposal'; edits: readonly SourceEdit[] }> |
	Readonly<{ kind: 'unchanged' }> |
	Readonly<{ kind: 'needs-context'; questions: readonly ContextQuestion[] }> |
	Readonly<{ kind: 'unsupported'; reason: 'length' | 'coverage'; message: string }> |
	Readonly<{ kind: 'failed'; message: string }>
);
export type Provenance = Readonly<{ output: Utf16Range; source: Utf16Range | null }>;
type AppliedText = Readonly<{ text: string; changes: readonly TextChange[]; provenance: readonly Provenance[] }>;
export type AppliedSkillResult = (Extract<EditSkillResult, { kind: 'proposal' | 'unchanged' }> & AppliedText) |
	Exclude<EditSkillResult, { kind: 'proposal' | 'unchanged' }>;
export type ContractCode = 'invalid-shape' | 'stale-source' | 'stale-job' | 'invalid-boundary' |
	'invalid-frame' | 'conflicting-edits' | 'protected-literal' | 'no-change';
export type Validation<T> = Readonly<{ ok: true; value: T }> |
	Readonly<{ ok: false; error: Readonly<{ code: ContractCode; path: string; message: string }> }>;

class ContractFailure extends Error {
	constructor(readonly code: ContractCode, readonly path: string, message: string) { super(message); }
}
function fail(code: ContractCode, path: string, message: string): never { throw new ContractFailure(code, path, message); }
function check<T>(operation: () => T): Validation<T> {
	try { return { ok: true, value: operation() }; }
	catch (error) {
		if (!(error instanceof ContractFailure)) throw error;
		return { ok: false, error: { code: error.code, path: error.path, message: error.message } };
	}
}
function object(value: unknown, keys: readonly string[], path: string): Record<string, unknown> {
	if (!value || typeof value !== 'object' || Array.isArray(value)) fail('invalid-shape', path, 'Expected an object.');
	if (Object.keys(value).some(key => !keys.includes(key))) fail('invalid-shape', path, 'Unexpected field.');
	return value as Record<string, unknown>;
}
function string(value: unknown, path: string): string {
	if (typeof value !== 'string' || !value.length) fail('invalid-shape', path, 'Expected a nonempty string.');
	return value;
}
function choice<T extends string>(value: unknown, choices: readonly T[], path: string): T {
	if (typeof value !== 'string' || !choices.includes(value as T)) fail('invalid-shape', path, 'Unrecognized value.');
	return value as T;
}
function array(value: unknown, path: string, nonempty = false): unknown[] {
	if (!Array.isArray(value) || (nonempty && !value.length)) fail('invalid-shape', path, 'Expected an array' + (nonempty ? ' with entries.' : '.'));
	return Array.from(value); // Holes become explicit invalid entries rather than escaping validation.
}
function unique(ids: readonly string[], path: string) {
	if (new Set(ids).size !== ids.length) fail('invalid-shape', path, 'IDs must be unique.');
}
function freeze<T>(value: T): T {
	if (value && typeof value === 'object' && !Object.isFrozen(value)) {
		for (const child of Object.values(value)) freeze(child);
		Object.freeze(value);
	}
	return value;
}

// Only host-created snapshots are accepted. Model responses contain references, never source definitions.
const snapshots = new WeakMap<SourceSnapshot, Map<string, number>>();
const requests = new WeakSet<EditRequest>();
const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
const literalKinds = ['identifier', 'path', 'code', 'literal'] as const;

export function createSourceSnapshot(input: SourceInput): SourceSnapshot {
	const id = string(input.id, 'source.id');
	if (!Number.isSafeInteger(input.revision) || input.revision < 0 || typeof input.text !== 'string') {
		fail('invalid-shape', 'source', 'Expected a nonnegative revision and source text.');
	}
	const valid = new Set([0, input.text.length]);
	for (const segment of graphemes.segment(input.text)) valid.add(segment.index);
	const offsets = input.allowedOffsets ? [...input.allowedOffsets] : [...valid];
	if (!offsets.includes(0) || !offsets.includes(input.text.length) || new Set(offsets).size !== offsets.length ||
		offsets.some(offset => !Number.isSafeInteger(offset) || !valid.has(offset))) {
		fail('invalid-boundary', 'source.allowedOffsets', 'Use unique grapheme boundaries including both source ends.');
	}
	offsets.sort((a, b) => a - b);
	const boundaries = offsets.map((offset, index) => ({ id: `b${index}`, offset }));
	const boundaryByOffset = new Map(boundaries.map(boundary => [boundary.offset, boundary.id]));
	const protectedLiterals = (input.protectedLiterals ?? []).map((literal, index) => {
		const path = `source.protectedLiterals[${index}]`;
		const start = boundaryByOffset.get(literal.start), end = boundaryByOffset.get(literal.end);
		if (start === undefined || end === undefined || literal.start >= literal.end) {
			fail('invalid-boundary', path, 'A protected occurrence must be a nonempty range of allowed boundaries.');
		}
		return { id: string(literal.id, path + '.id'), kind: choice(literal.kind, literalKinds, path + '.kind'), range: { start, end } };
	});
	unique(protectedLiterals.map(literal => literal.id), 'source.protectedLiterals');
	const source: SourceSnapshot = freeze({ id, revision: input.revision, text: input.text,
		// Bind the text AND host boundary/protection policy; old IDs must not acquire new meanings.
		digest: createHash('sha256').update(JSON.stringify({ schemaVersion: 1, text: input.text, boundaries, protectedLiterals }), 'utf16le').digest('hex'),
		boundaries, protectedLiterals });
	snapshots.set(source, new Map(boundaries.map(boundary => [boundary.id, boundary.offset])));
	return source;
}
function hostSource(source: SourceSnapshot): Map<string, number> {
	const boundaries = snapshots.get(source);
	if (!boundaries) fail('invalid-shape', 'source', 'Use a host-created source snapshot.');
	return boundaries;
}
export function sourceRef(source: SourceSnapshot): SourceRef {
	hostSource(source);
	return freeze({ id: source.id, revision: source.revision, digest: source.digest });
}
export function sourceRange(source: SourceSnapshot, start: number, end: number): SourceRange {
	hostSource(source);
	const first = source.boundaries.find(boundary => boundary.offset === start);
	const last = source.boundaries.find(boundary => boundary.offset === end);
	if (!first || !last || start >= end) fail('invalid-boundary', 'range', 'Expected a nonempty range of allowed boundaries.');
	return freeze({ start: first.id, end: last.id });
}
export function createEditRequest(source: SourceSnapshot, jobId: string): EditRequest {
	hostSource(source);
	const request = freeze({ schemaVersion: 1 as const, source, jobId: string(jobId, 'jobId') });
	requests.add(request);
	return request;
}
function matchSource(source: SourceSnapshot, input: unknown, path: string): SourceRef {
	const ref = object(input, ['id', 'revision', 'digest'], path);
	if (ref.id !== source.id || ref.revision !== source.revision || ref.digest !== source.digest) {
		fail('stale-source', path, 'The result belongs to another source snapshot.');
	}
	return sourceRef(source);
}
function boundary(source: SourceSnapshot, id: unknown, path: string): number {
	const offset = typeof id === 'string' ? hostSource(source).get(id) : undefined;
	if (offset === undefined) fail('invalid-boundary', path, 'Unknown source boundary.');
	return offset;
}
function range(source: SourceSnapshot, input: unknown, path: string): SourceRange {
	const value = object(input, ['start', 'end'], path);
	const start = boundary(source, value.start, path + '.start'), end = boundary(source, value.end, path + '.end');
	if (start >= end) fail('invalid-boundary', path, 'Use a nonempty source range; insertions have an at boundary.');
	return { start: value.start as string, end: value.end as string };
}
function offsets(source: SourceSnapshot, value: SourceRange): Utf16Range {
	return { start: boundary(source, value.start, 'range.start'), end: boundary(source, value.end, 'range.end') };
}
function evidence(source: SourceSnapshot, input: unknown, path: string): SourceRange[] {
	return array(input, path, true).map((value, index) => range(source, value, `${path}[${index}]`));
}
function questions(source: SourceSnapshot, input: unknown, path: string, nonempty: boolean): ContextQuestion[] {
	const values = array(input, path, nonempty).map((entry, index) => {
		const at = `${path}[${index}]`, value = object(entry, ['id', 'question', 'evidence'], at);
		return { id: string(value.id, at + '.id'), question: string(value.question, at + '.question'),
			evidence: evidence(source, value.evidence, at + '.evidence') };
	});
	unique(values.map(value => value.id), path);
	return values;
}
function frame(source: SourceSnapshot, input: unknown): ObligationFrame {
	const value = object(input, ['source', 'nodes', 'relations', 'unresolved'], 'obligations');
	const ref = matchSource(source, value.source, 'obligations.source');
	const nodes = array(value.nodes, 'obligations.nodes').map((entry, index): ObligationNode => {
		const path = `obligations.nodes[${index}]`, node = object(entry, ['id', 'role', 'modality', 'evidence'], path);
		const role = choice(node.role, ['action', 'target', 'condition', 'exception', 'scope', 'quantity', 'comparator', 'literal'], path + '.role');
		const base = { id: string(node.id, path + '.id'), evidence: evidence(source, node.evidence, path + '.evidence') };
		if (role === 'action') return { ...base, role, modality: choice(node.modality, ['required', 'permitted', 'prohibited', 'unspecified'], path + '.modality') };
		if ('modality' in node) fail('invalid-frame', path, 'Only actions carry modality.');
		return { ...base, role };
	});
	unique(nodes.map(node => node.id), 'obligations.nodes');
	const ids = new Set(nodes.map(node => node.id));
	const relations = array(value.relations, 'obligations.relations').map((entry, index): ObligationRelation => {
		const path = `obligations.relations[${index}]`, relation = object(entry, ['id', 'kind', 'from', 'to'], path);
		const from = string(relation.from, path + '.from'), to = string(relation.to, path + '.to');
		if (!ids.has(from) || !ids.has(to)) fail('invalid-frame', path, 'Relation endpoints must name nodes in this frame.');
		return { id: string(relation.id, path + '.id'), from, to,
			kind: choice(relation.kind, ['target', 'condition', 'exception', 'scope', 'quantity', 'comparator', 'before', 'reference'], path + '.kind') };
	});
	unique(relations.map(relation => relation.id), 'obligations.relations');
	return freeze({ source: ref, nodes, relations, unresolved: questions(source, value.unresolved, 'obligations.unresolved', false) });
}

/** Checks source binding, schema and references; it does not certify the inferred meaning or completeness. */
export function validateObligationFrame(source: SourceSnapshot, input: unknown): Validation<ObligationFrame> {
	return check(() => { hostSource(source); return frame(source, input); });
}
function pieces(source: SourceSnapshot, input: unknown, path: string): EditPiece[] {
	return array(input, path, true).map((entry, index) => {
		const at = `${path}[${index}]`, value = object(entry, ['kind', 'text', 'range'], at);
		if (value.kind === 'text') {
			object(value, ['kind', 'text'], at);
			return { kind: 'text', text: string(value.text, at + '.text') };
		}
		if (value.kind === 'copy') {
			object(value, ['kind', 'range'], at);
			return { kind: 'copy', range: range(source, value.range, at + '.range') };
		}
		return fail('invalid-shape', at + '.kind', 'Expected text or copy.');
	});
}
function edits(source: SourceSnapshot, input: unknown): SourceEdit[] {
	const values = array(input, 'edits', true).map((entry, index): SourceEdit => {
		const path = `edits[${index}]`, edit = object(entry, ['id', 'kind', 'at', 'range', 'content'], path);
		const id = string(edit.id, path + '.id');
		if (edit.kind === 'insert') {
			object(edit, ['id', 'kind', 'at', 'content'], path);
			boundary(source, edit.at, path + '.at');
			return { id, kind: 'insert', at: edit.at as string, content: pieces(source, edit.content, path + '.content') };
		}
		if (edit.kind === 'replace') {
			object(edit, ['id', 'kind', 'range', 'content'], path);
			return { id, kind: 'replace', range: range(source, edit.range, path + '.range'), content: pieces(source, edit.content, path + '.content') };
		}
		if (edit.kind === 'delete') {
			object(edit, ['id', 'kind', 'range'], path);
			return { id, kind: 'delete', range: range(source, edit.range, path + '.range') };
		}
		return fail('invalid-shape', path + '.kind', 'Expected insert, replace or delete.');
	});
	unique(values.map(value => value.id), 'edits');
	return values;
}
function parseResult(request: EditRequest, input: unknown): EditSkillResult {
	if (!requests.has(request)) fail('invalid-shape', 'request', 'Use a host-created edit request.');
	const baseKeys = ['schemaVersion', 'jobId', 'source', 'obligations', 'kind'];
	const value = object(input, [...baseKeys, 'edits', 'questions', 'reason', 'message'], 'result');
	if (value.schemaVersion !== 1) fail('invalid-shape', 'schemaVersion', 'Unsupported contract version.');
	if (value.jobId !== request.jobId) fail('stale-job', 'jobId', 'The result belongs to another job.');
	const base: ResultEnvelope = { schemaVersion: 1, jobId: request.jobId,
		source: matchSource(request.source, value.source, 'result.source'),
		...('obligations' in value ? { obligations: frame(request.source, value.obligations) } : {}) };
	switch (value.kind) {
		case 'proposal':
			object(value, [...baseKeys, 'edits'], 'result');
			return { ...base, kind: 'proposal', edits: edits(request.source, value.edits) };
		case 'unchanged':
			object(value, baseKeys, 'result');
			return { ...base, kind: 'unchanged' };
		case 'needs-context':
			object(value, [...baseKeys, 'questions'], 'result');
			return { ...base, kind: 'needs-context', questions: questions(request.source, value.questions, 'questions', true) };
		case 'unsupported':
			object(value, [...baseKeys, 'reason', 'message'], 'result');
			return { ...base, kind: 'unsupported', reason: choice(value.reason, ['length', 'coverage'], 'reason'), message: string(value.message, 'message') };
		case 'failed':
			object(value, [...baseKeys, 'message'], 'result');
			return { ...base, kind: 'failed', message: string(value.message, 'message') };
		default: return fail('invalid-shape', 'kind', 'Unknown skill outcome.');
	}
}

function apply(source: SourceSnapshot, plan: readonly SourceEdit[]): AppliedText {
	const sorted = plan.map(edit => ({ edit, ...(edit.kind === 'insert'
		? { start: boundary(source, edit.at, 'at'), end: boundary(source, edit.at, 'at') } : offsets(source, edit.range)) }))
		.sort((a, b) => a.start - b.start || a.end - b.end);
	let cursor = 0, priorStart = -1;
	for (const edit of sorted) {
		if (edit.start < cursor || edit.start === priorStart) {
			fail('conflicting-edits', 'edits', 'Edits overlap or share a start boundary. Combine same-boundary operations explicitly.');
		}
		cursor = edit.end; priorStart = edit.start;
	}
	const chunks: string[] = [], provenance: Provenance[] = [], changes: TextChange[] = [];
	let outputOffset = 0;
	const append = (text: string, from: Utf16Range | null) => {
		if (!text.length) return;
		chunks.push(text);
		provenance.push({ output: { start: outputOffset, end: outputOffset + text.length }, source: from });
		outputOffset += text.length;
	};
	const copy = (start: number, end: number) => append(source.text.slice(start, end), { start, end });
	cursor = 0;
	for (const { edit, start, end } of sorted) {
		copy(cursor, start);
		const replacementStart = chunks.length;
		if (edit.kind !== 'delete') for (const piece of edit.content) {
			if (piece.kind === 'text') append(piece.text, null);
			else { const from = offsets(source, piece.range); copy(from.start, from.end); }
		}
		changes.push({ rangeOffset: start, rangeLength: end - start, text: chunks.slice(replacementStart).join('') });
		cursor = end;
	}
	copy(cursor, source.text.length);
	for (const literal of source.protectedLiterals) {
		const expected = offsets(source, literal.range);
		let copies = 0;
		for (const part of provenance) {
			if (!part.source || part.source.end <= expected.start || part.source.start >= expected.end) continue;
			if (part.source.start > expected.start || part.source.end < expected.end) {
				fail('protected-literal', literal.id, 'A protected occurrence cannot be split or partially overwritten.');
			}
			copies++;
		}
		if (copies !== 1) fail('protected-literal', literal.id, 'Keep each protected occurrence exactly once, unchanged or through a source-copy piece.');
	}
	const text = chunks.join('');
	if (text === source.text) fail('no-change', 'edits', 'Use the unchanged outcome for a no-op.');
	return { text, changes, provenance };
}

/** Pure, atomic application. No draft mutation, human approval, semantic certification or detector bypass. */
export function applyEditResult(request: EditRequest, input: unknown): Validation<AppliedSkillResult> {
	return check(() => {
		const result = parseResult(request, input);
		if (result.kind === 'proposal') return freeze({ ...result, ...apply(request.source, result.edits) });
		if (result.kind === 'unchanged') return freeze({ ...result, text: request.source.text, changes: [],
			provenance: request.source.text.length ? [{ output: { start: 0, end: request.source.text.length },
				source: { start: 0, end: request.source.text.length } }] : [] });
		return freeze(result);
	});
}
