import type { PromptMapping } from './prompt-mapping';
import { mappingSections } from './mapping-summary';

export type Clarification = {id: string; question: string; quotes: string[]; range?: {start: number; end: number}};
export type Answer = {questionId: string; text: string};
export type ClarifiedMapping = {frame: PromptMapping; parsed: PromptMapping; answers?: Answer[]};

export function clarificationQuestions({frame, parsed}: ClarifiedMapping): Clarification[] {
	const questions = parsed.graph?.questions ?? [];
	const result: Clarification[] = [];
	for (const text of new Set(frame.reviewFields?.unresolved ?? frame.unresolved)) {
		const matches = questions.filter(q => q.question === text);
		if (matches.length) result.push(...matches);
		else result.push({id: 'review:' + text, question: text, quotes: []});
	}
	return result;
}

export function reviewedSections(mapping: ClarifiedMapping, wording: string) {
	const sections = mappingSections(mapping.frame, mapping.parsed, wording);
	if (mapping.answers?.length) {
		sections.unresolved = [...new Set(clarificationQuestions(mapping)
			.filter(q => !mapping.answers!.some(a => a.questionId === q.id)).map(q => q.question))];
	}
	return sections;
}

export function promptPreview(mapping: ClarifiedMapping, wording: string) {
	const questions = clarificationQuestions(mapping);
	const answers = mapping.answers ?? [];
	const pending = questions.find(q => !answers.some(a => a.questionId === q.id));
	if (pending) return {questions, pending, text: undefined};

	const notes: string[] = [];
	const edits: {start: number; end: number; text: string}[] = [];
	for (const q of questions) {
		const answer = answers.find(a => a.questionId === q.id)!.text;
		const span = q.range;
		// A path can replace a complete target phrase directly. Keep free-form decisions,
		// overlapping evidence and non-target answers explicit alongside their source.
		if (span && q.question === 'Which file or component is the target?' &&
			/^(?:[\w.@-]+[/\\])+[\w.@-]+$/.test(answer) &&
			wording.slice(span.start, span.end) === q.quotes[0] &&
			!/[\p{L}\p{N}_]/u.test(wording[span.start - 1] ?? '') &&
			!/[\p{L}\p{N}_]/u.test(wording[span.end] ?? '')) {
			const article = /\bthe $/i.test(wording.slice(0, span.start)) ? 4 : 0;
			const start = span.start - article;
			if (!edits.some(e => start < e.end && e.start < span.end)) {
				edits.push({start, end: span.end, text: answer});
				continue;
			}
		}
		const quote = q.quotes.length ? ' (' + q.quotes.join(' … ') + ')' : '';
		notes.push(q.question + quote + '\n' + answer);
	}
	let text = wording;
	for (const edit of edits.sort((a, b) => b.start - a.start))
		text = text.slice(0, edit.start) + edit.text + text.slice(edit.end);
	return {questions, pending: undefined, text: withReviewedMapping(text, mapping.frame, mapping.parsed, wording, notes)};
}

export function withReviewedMapping(text: string, frame: PromptMapping, parsed: PromptMapping, wording = text, notes: string[] = []) {
	if (frame !== parsed) {
		const current = mappingSections(frame, parsed, wording);
		const original = mappingSections(parsed, parsed, wording);
		for (const key of Object.keys(current) as (keyof typeof current)[]) {
			if (key === 'unresolved' || !current[key]?.length || JSON.stringify(current[key]) === JSON.stringify(original[key])) continue;
			const title = key.replace(/([A-Z])/g, ' $1').toLowerCase();
			notes.push(title[0].toUpperCase() + title.slice(1) + ': ' + current[key]!.join('\n'));
		}
	}
	return notes.length ? text + '\n\n' + notes.join('\n\n') : text;
}
