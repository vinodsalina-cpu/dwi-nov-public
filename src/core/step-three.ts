import { createHash, randomUUID } from 'node:crypto';
import { clarificationQuestions } from './clarification';
import { answerInput, answerText, isRecord, validateAnswer, type AnswerSpec, type AnswerValue, type Field, type FileAnswer } from './question-input';
import { readPromptMapping, reviewFieldNames, type PromptMapping, type ReviewFields } from './prompt-mapping';

export const questionLimit = 7;
export const recoveryLimit = 3;
export const returnToInput = 'Current input cannot be processed ahead. Please utilise step 1 again';
export type Reference = { label: string; excerpt: string };
export type ApprovedEvidence = { relevance: 'match' | 'none' | 'unknown'; references: readonly Reference[] };
export type Question = {
	id: string; prompt: string; control: AnswerSpec; blocking: boolean; quotes: string[];
	reference?: Reference; recovery?: true; replaces?: { start: number; end: number; choices?: Record<string, string>; inline?: true };
};
export type Response = { kind: 'skipped' } | { kind: 'answered'; value: AnswerValue };
export type Step = { question: Question; response?: Response };
export type ClarificationHistory = {
	schemaVersion: 1; id: string; wording: string; position: number; path: Step[];
	orphaned: { steps: Step[]; at: string }[]; terminal?: true;
	mappingEdits?: { wording: string; fields: ReviewFields };
};
export type StepThreeMapping = { parsed: PromptMapping; frame: PromptMapping; wording: string; editVersion: number };
export type StepThreeState = {
	history: ClarificationHistory; status: 'checking' | 'questions' | 'ready' | 'blocked' | 'failed' | 'resume';
	mapping?: StepThreeMapping; total: number; severity: 'low' | 'high' | 'critical'; message?: string; alert?: string;
};
export type StepThreeServices = {
	map: (wording: string, signal: AbortSignal, id: string) => Promise<PromptMapping>;
	context?: (wording: string, signal: AbortSignal) => Promise<ApprovedEvidence>;
};
export const newHistory = (wording: string): ClarificationHistory => ({ schemaVersion: 1, id: randomUUID(), wording, position: 0, path: [], orphaned: [] });
const noEvidence: ApprovedEvidence = { relevance: 'unknown', references: [] };
const key = (pieces: unknown[]) => createHash('sha256').update(JSON.stringify(pieces)).digest('hex').slice(0, 24);
const text = (prompt: string, quotes: string[], at: number, blocking = true): Question => ({
	id: key([prompt, at, quotes]), prompt, control: { kind: 'value', format: 'text' }, blocking, quotes,
});

export function activeDecisions(history: ClarificationHistory) {
	return history.path.flatMap(({ question, response }) => response?.kind === 'answered'
		? [{ question: question.prompt, answer: answerText(question.control, response.value) }] : []);
}

/** Replaying navigation keeps the committed suffix. A changed answer detaches it in one update. */
export function commitAnswer(history: ClarificationHistory, response: Response): boolean {
	const active = history.path[history.position];
	if (JSON.stringify(active.response) === JSON.stringify(response)) return false;
	const later = history.path.splice(history.position + 1);
	if (later.length) history.orphaned.push({ steps: later, at: new Date().toISOString() });
	active.response = response;
	history.mappingEdits = undefined;
	return true;
}

export function assessmentWording(history: ClarificationHistory) {
	const edits: { start: number; end: number; text: string }[] = [];
	const evidence: string[] = [];
	const applied = new Set<string>();
	for (const { question, response } of history.path) {
		if (response?.kind !== 'answered') continue;
		const value = answerText(question.control, response.value);
		const range = question.replaces;
		let replacement = range?.inline ? value.replace(/\n/gu, ', ') : value;
		if (range?.choices && !Array.isArray(response.value) && typeof response.value === 'object' && 'selected' in response.value) {
			const original = history.wording.slice(range.start, range.end);
			replacement = range.choices[response.value.selected[0]] ??
				`${original.match(/^\s*/u)?.[0] ?? ''}${value}${/[.!?]$/u.test(value) ? '' : '.'}`;
		}
		if (range && replacement && edits.every(edit => edit.end <= range.start || range.end <= edit.start)) {
			edits.push({ start: range.start, end: range.end, text: replacement });
			applied.add(question.id);
		} else if (value) {
			// Keep the user's response as an explicit statement, with its subject when known.
			const subject = question.quotes.length === 1 ? question.quotes[0] : undefined;
			evidence.push(subject ? `${subject}: ${value}` : value);
		}
	}
	let wording = history.wording;
	edits.sort((a, b) => a.start - b.start);
	for (const edit of edits.slice().reverse()) wording = wording.slice(0, edit.start) + edit.text + wording.slice(edit.end);
	function sourceOffset(start: number, length: number) {
		if (start < 0 || start + length > wording.length) return -1;
		let delta = 0;
		for (const edit of edits) {
			const output = edit.start + delta;
			if (start + length <= output) break;
			if (start < output + edit.text.length) return -1;
			delta += edit.text.length - (edit.end - edit.start);
		}
		return start - delta;
	}
	return { wording: [wording, ...evidence].join('\n\n'), applied, sourceOffset };
}

function explicitQuestions(wording: string): Question[] {
	const choices: Question[] = [];
	const clauses = Array.from(wording.matchAll(/(?:^|(?<=[.!?\n]))\s*\b(include|exclude|enable|disable|allow|deny)\s+([^.!?\n]+)[.!?]?/giu));
	const opposite: Record<string, string> = { include: 'exclude', exclude: 'include', enable: 'disable', disable: 'enable', allow: 'deny', deny: 'allow' };
	for (let index = 0; index + 1 < clauses.length; index++) {
		const first = clauses[index], second = clauses[index + 1];
		if (first.index + first[0].length !== second.index || opposite[first[1].toLowerCase()] !== second[1].toLowerCase() ||
			first[2].trim().toLowerCase() !== second[2].trim().toLowerCase()) continue;
		const labels = [first[0].trim(), second[0].trim()];
		choices.push({ ...text(`Which instruction should apply to ${first[2].trim()}?`, labels, first.index),
			control: { kind: 'choice', options: labels.map((label, i) => ({ id: String(i), label })), other: true },
			replaces: { start: first.index, end: second.index + second[0].length, choices: { '0': first[0], '1': first[0].match(/^\s*/u)![0] + labels[1] } } });
	}
	for (const match of wording.matchAll(/\b(?:TBD|unspecified|unknown)\s+(days|hours|minutes|seconds)\b/giu)) {
		const unit = match[1].toLowerCase();
		choices.push({ ...text(`How many ${unit}?`, [match[0]], match.index),
			control: { kind: 'value', format: 'integer', unit, min: 1 }, replaces: { start: match.index, end: match.index + match[0].length } });
	}
	for (const match of wording.matchAll(/\bthe\s+((?:affected|intended|unspecified)\s+file)\b(?!\s*(?:[:=(]|(?:named|called|in|at)\b))/giu)) {
		if (/\b(?:the\s+)?(?:affected\s+)?file\s*[:=]\s*\S/iu.test(wording)) continue;
		choices.push({...text('Which file or component is the target?', [match[1]], match.index),
			control: {kind:'file'}, replaces: {start:match.index, end:match.index + match[0].length}});
	}
	for (const match of wording.matchAll(/\b(one or more of|either)\s*:?\s+([^;.!?\n]+)/giu)) {
		if (/\b(?:whichever|your choice|any is fine|whatever works)\b/iu.test(match[2])) continue;
		const options = match[2].split(/\s*,\s*(?:(?:or|and)\s+)?|\s+(?:or|and)\s+/iu).map(option => option.trim()).filter(Boolean);
		if (options.length < 2 || new Set(options.map(option => option.toLowerCase())).size !== options.length) continue;
		const prompt = match[1].toLowerCase() === 'either' ? 'Which option should apply?' : 'Which options should apply?';
		choices.push({...text(prompt, [match[0]], match.index), control: {kind:'choice', multiple: match[1].toLowerCase() !== 'either',
			options: options.map((label, i) => ({id: String(i), label})), other: true},
			replaces: { start: match.index, end: match.index + match[0].length, inline: true }});
	}
	return choices;
}

function semanticQuestions(frame: PromptMapping, history: ClarificationHistory, source: ReturnType<typeof assessmentWording>, references: readonly Reference[]) {
	const effective = source.wording;
	return clarificationQuestions({ frame, parsed: frame }).map(candidate => {
		const quote = candidate.quotes[0];
		const at = candidate.range?.start ?? (quote ? effective.indexOf(quote) : -1);
		const origin = quote ? source.sourceOffset(at, quote.length) : -1;
		const original = origin >= 0 && history.wording.slice(origin, origin + quote.length) === quote;
		const start = Math.max(0, effective.lastIndexOf('\n', at) + 1, effective.lastIndexOf('.', at) + 1);
		const end = effective.indexOf('.', Math.max(0, at));
		const optional = at >= 0 && /\b(?:optional(?:ly)?|if desired|if useful)\b/i.test(effective.slice(start, end < 0 ? undefined : end));
		const question = text(candidate.question, candidate.quotes, origin >= 0 ? origin : at, !optional);
		if (/^Which file or component/u.test(candidate.question) && original && /\bfile\b/iu.test(quote)) {
			const article = history.wording.slice(Math.max(0, origin - 4), origin).toLowerCase() === 'the ' ? 4 : 0;
			question.control = { kind: 'file' };
			question.replaces = { start: origin - article, end: origin + quote.length };
			question.reference = references[0];
		} else if (quote) {
			question.reference = references.find(reference => reference.excerpt.includes(quote));
		}
		return question;
	});
}

function bundleQuestions(pool: Question[], slots: number): Question[] {
	if (pool.length <= slots) return pool;
	const first = pool[0];
	// Shared source evidence can bind two fields to a single decision. Keep edits and groups separate.
	const second = first && !first.replaces && first.quotes.length === 1 && pool.slice(1).find(candidate =>
		!candidate.replaces && candidate.quotes.length === 1 && candidate.quotes[0] === first.quotes[0]);
	if (!second) return pool;
	return [{ ...first, id: key([first.id, second.id]), prompt: `Clarify “${first.quotes[0]}”.`,
		blocking: first.blocking || second.blocking, control: { kind: 'fields', fields: [first, second].map(question => ({
			id: question.id, prompt: question.prompt, field: question.control as Field,
		})) } }, ...pool.filter(question => question !== first && question !== second)];
}

type Assessment = Pick<StepThreeState, 'status' | 'mapping' | 'message' | 'severity' | 'total'>;
export async function assessStepThree(history: ClarificationHistory, services: StepThreeServices, id: string,
	signal: AbortSignal, seed: readonly { prompt: string; quotes: string[] }[] = []): Promise<Assessment> {
	const source = assessmentWording(history);
	const { wording, applied } = source;
	const context = await (services.context?.(wording, signal) ?? Promise.resolve(noEvidence));
	signal.throwIfAborted();
	const frame = await services.map(wording, signal, id);
	signal.throwIfAborted();
	const answered = history.path.filter(step => step.response !== undefined);
	const slots = questionLimit - answered.length;
	const originalQuestions = explicitQuestions(history.wording);
	const seen = new Set(answered.flatMap(({ question }) => [question.id, ...(question.control.kind === 'fields' ? question.control.fields.map(field => field.id) : [])]));
	const generic = /^(?:(?:could|would|can|will) you )?(?:please )?(?:fix|change|update|do|make|handle)\s+(?:(?:that|this|the)\s+)?(?:thing|stuff|something|it)(?:\s+(?:from before|better|for me))?\s*[.!?]*$/iu.test(history.wording.trim());
	const genericWords = new Set(['same', 'some', 'thing', 'stuff', 'something', 'anything', 'nothing', 'this',
		'that', 'from', 'before', 'usual', 'whatever', 'exactly', 'again', 'sure', 'know', 'which', 'help', 'please']);
	const words = (text: string) => text.toLowerCase().match(/[\p{L}\p{N}_]+(?:[./-][\p{L}\p{N}_]+)*/gu) ?? [];
	const originalWords = new Set(words(history.wording));
	const targetWords = new Set(frame.targets.flatMap(target => words(target)
		.filter(word => word.length >= 3 && !genericWords.has(word) && !originalWords.has(word))));
	const resolvedGenericTarget = generic && (targetWords.size > 1 || [...targetWords].some(word => /[./][\p{L}\p{N}]/u.test(word)));
	const inferred = semanticQuestions(frame, history, source, context.references).filter(question => {
		const range = question.replaces;
		if (range && originalQuestions.some(original => original.prompt === question.prompt &&
			original.replaces?.start === range.start && original.replaces.end === range.end)) return false;
		return !resolvedGenericTarget || question.prompt !== 'Which file or component is the target?' ||
			!question.quotes.length || !question.quotes.every(quote => history.wording.includes(quote));
	});
	const needs = [
		...originalQuestions.filter(question => !applied.has(question.id)).map(question =>
			question.control.kind === 'file' ? {...question, reference:context.references[0]} : question),
		...inferred,
		...(!answered.length ? seed.map(question => text(question.prompt, question.quotes, question.quotes.length ? wording.indexOf(question.quotes[0]) : -1)) : []),
	];
	const unique = [...new Map(needs.map(question => [question.id, question])).values()];
	const actionable = !!frame.actions.length && (!generic || resolvedGenericTarget);
	const recovery = !actionable && context.relevance !== 'match' && (generic || !frame.actions.length);
	if (!actionable && (!unique.some(question => question.blocking) || recovery && !unique.some(question => question.blocking && !seen.has(question.id)))) {
		const attempts = answered.filter(step => step.question.recovery).length;
		const prompts = ['What specific action should be taken?', 'What file, component, or outcome should change?', 'What single change should be made, and where?'];
		unique.push({ ...text(prompts[Math.min(attempts, recoveryLimit - 1)], [], attempts), ...(recovery && { recovery: true }) });
	}
	const blockers = unique.filter(question => question.blocking);
	const viable = actionable && !blockers.length;
	let mapping = viable ? { frame, parsed: frame, wording, editVersion: 0 } : undefined;
	if (mapping && history.mappingEdits?.wording === wording) mapping = saveStepThreeMapping(mapping, history.mappingEdits.fields);
	const pool = bundleQuestions(unique.filter(question => !seen.has(question.id)).sort((a, b) => Number(b.blocking) - Number(a.blocking)), slots);
	const next = pool[0];
	if (viable && (!next || slots <= 0)) return { status: 'ready', mapping, total: history.path.length, severity: 'low' };
	if (!next || slots <= 0 || (recovery && answered.filter(step => step.question.recovery).length >= recoveryLimit)) {
		history.terminal = true;
		return { status: 'blocked', total: history.path.length, severity: 'critical', message: blockers[0]?.prompt };
	}
	if (recovery) next.recovery = true;
	history.path = [...answered, { question: next }];
	history.position = answered.length;
	return { status: 'questions', mapping,
		total: recovery ? recoveryLimit : Math.min(questionLimit, answered.length + pool.length),
		severity: recovery || blockers.length > 1 ? 'critical' : blockers.length ? 'high' : 'low' };
}

function isFile(value: unknown): value is FileAnswer {
	return isRecord(value) && typeof value.uri === 'string' && value.uri.startsWith('file:') && typeof value.label === 'string' && !!value.label;
}
function isField(value: unknown): value is Field {
	if (!isRecord(value)) return false;
	if (value.kind === 'value') return ['text', 'integer', 'decimal', 'date', 'time'].includes(String(value.format)) &&
		(value.unit === undefined || typeof value.unit === 'string') && ['min', 'max', 'maxLength'].every(key => value[key] === undefined || Number.isFinite(value[key]));
	if (value.kind === 'file') return value.multiple === undefined || typeof value.multiple === 'boolean';
	return value.kind === 'choice' && Array.isArray(value.options) && value.options.length > 0 &&
		value.options.every(option => isRecord(option) && typeof option.id === 'string' && typeof option.label === 'string') &&
		new Set(value.options.map(option => option.id)).size === value.options.length;
}
function isSpec(value: unknown): value is AnswerSpec {
	if (isField(value)) return true;
	return isRecord(value) && value.kind === 'fields' && Array.isArray(value.fields) && value.fields.length > 1 &&
		value.fields.every(field => isRecord(field) && typeof field.prompt === 'string' && typeof field.id === 'string' && /^[\da-f]+$/u.test(field.id) && isField(field.field));
}
export function restoreClarification(value: unknown): ClarificationHistory | undefined {
	if (!isRecord(value) || value.schemaVersion !== 1 || typeof value.id !== 'string' || !value.id || typeof value.wording !== 'string' || !value.wording.trim() ||
		typeof value.position !== 'number' || !Number.isSafeInteger(value.position) || value.position < 0 || !Array.isArray(value.path) ||
		value.path.length > questionLimit || value.position >= Math.max(1, value.path.length) || !Array.isArray(value.orphaned) ||
		(value.terminal !== undefined && value.terminal !== true)) return;
	const wording = value.wording;
	if (value.mappingEdits !== undefined && (!isRecord(value.mappingEdits) || typeof value.mappingEdits.wording !== 'string' ||
		!isRecord(value.mappingEdits.fields) || !Object.entries(value.mappingEdits.fields).every(([key, lines]) =>
			reviewFieldNames.some(field => field === key) && Array.isArray(lines) && lines.every(line => typeof line === 'string' && !!line.trim())))) return;
	const validStep = (entry: unknown, checkSource: boolean): entry is Step => {
		if (!isRecord(entry) || !isRecord(entry.question)) return false;
		const q = entry.question;
		if (typeof q.id !== 'string' || typeof q.prompt !== 'string' || typeof q.blocking !== 'boolean' || !isSpec(q.control) ||
			!Array.isArray(q.quotes) || !q.quotes.every(quote => typeof quote === 'string')) return false;
		if (q.reference !== undefined && (!isRecord(q.reference) || typeof q.reference.label !== 'string' || typeof q.reference.excerpt !== 'string')) return false;
		if (q.replaces !== undefined && (!isRecord(q.replaces) || typeof q.replaces.start !== 'number' || typeof q.replaces.end !== 'number' ||
			!Number.isSafeInteger(q.replaces.start) || !Number.isSafeInteger(q.replaces.end) || q.replaces.start < 0 ||
			q.replaces.end <= q.replaces.start || (checkSource && q.replaces.end > wording.length) ||
			(q.replaces.inline !== undefined && q.replaces.inline !== true) ||
			(q.replaces.choices !== undefined && (!isRecord(q.replaces.choices) || !Object.values(q.replaces.choices).every(item => typeof item === 'string'))))) return false;
		if (entry.response === undefined) return true;
		if (!isRecord(entry.response)) return false;
		if (entry.response.kind === 'skipped') return true;
		if (entry.response.kind !== 'answered') return false;
		const response = entry.response.value as AnswerValue;
		try {
			const files = Array.isArray(response) ? response : typeof response === 'object' && 'fields' in response
				? Object.values(response.fields).flatMap(field => Array.isArray(field) ? field : []) : [];
			const checked = validateAnswer(q.control, answerInput(response), files.filter(isFile));
			return checked.ok && JSON.stringify(checked.value) === JSON.stringify(response);
		} catch { return false; }
	};
	if (!value.path.every(step => validStep(step, true)) || value.path.slice(0, -1).some(step => !step.response) ||
		!value.orphaned.every(item => isRecord(item) && typeof item.at === 'string' && Array.isArray(item.steps) &&
			item.steps.every(step => validStep(step, false)))) return;
	return structuredClone(value) as unknown as ClarificationHistory;
}

export function saveStepThreeMapping(mapping: StepThreeMapping, fields: unknown): StepThreeMapping {
	const frame = readPromptMapping({ ...mapping.parsed, reviewFields: fields }, mapping.wording, mapping.frame.id, 'developer');
	return { ...mapping, frame, editVersion: mapping.editVersion + 1 };
}
