import type { HarperReview } from './harper-review';
import type { TextChange } from './request-review';
import { asciiWords, markovBaseline, score, type TextSpan } from './markov';

export type Choice = TextSpan & { replacement: string; custom: boolean };
export type TextIssue = TextSpan & {
	candidates: string[];
	candidateContextScores?: Record<string, number>;
	replacement?: string;
	minor?: true;
};
const asciiWord = /^[A-Za-z]+$/;

export function parseWordReplacement(value: string) {
	const trimmed = value.replace(/^[\s\p{White_Space}]+|[\s\p{White_Space}]+$/gu, '');
	const boundary = trimmed.search(/[\s\p{White_Space}]/u);
	const first = boundary < 0 ? trimmed : trimmed.slice(0, boundary);
	return { word: asciiWord.test(first) ? first : undefined, multiple: boundary >= 0 };
}

export function isMinorCorrection(original: string, replacement: string) {
	const before = original.toLowerCase(), after = replacement.toLowerCase();
	// DWI also treats this common contraction shorthand as a minor correction.
	if (before === 'dnt' && /^don['’]t$/.test(after)) return true;
	return before.replace(/\p{P}/gu, '') === after.replace(/\p{P}/gu, '');
}

export function isWordReplacement(original: string, replacement: string) {
	return !asciiWord.test(original) || asciiWord.test(replacement) || isMinorCorrection(original, replacement);
}

export function replacementCaseMismatch(original: string, replacement: string) {
	if (!asciiWord.test(original) || !asciiWord.test(replacement)) return false;
	if (/^[a-z]+$/.test(original)) return !/^[a-z]+$/.test(replacement);
	if (/^[A-Z]+$/.test(original)) return !/^[A-Z]+$/.test(replacement);
	return /^[A-Z][a-z]+$/.test(original) && !/^[A-Z][a-z]*$/.test(replacement);
}
const wordSegments = new Intl.Segmenter(undefined, { granularity: 'word' });
const characters = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
const minimumWords = 5;
const minimumCharacters = 15;

export function meetsDraftMinimums(text: string): boolean {
	const draft = text.trim();
	if (draft.length < minimumCharacters) return false;
	let words = 0;
	for (const part of wordSegments.segment(draft)) {
		if (part.isWordLike && /\p{L}/u.test(part.segment) && ++words === minimumWords) break;
	}
	if (words < minimumWords) return false;
	let length = 0;
	for (const _ of characters.segment(draft)) {
		if (++length === minimumCharacters) return true;
	}
	return false;
}

/** Screen obvious filler while allowing ordinary typos, names and uncertain wording through. */
export function hasPlausibleWording(text: string, flags: readonly TextSpan[], findings: HarperReview['findings']): boolean {
	const flaggedEnds = new Map(flags.map(word => [word.start, word.end]));
	const spelling = new Set(findings.filter(f => f.kind === 'Spelling').map(f => f.start));
	const distinct = new Set<string>();
	const plausible = new Set<string>();
	let total = 0;
	let noisy = 0;
	for (const { segment, index, isWordLike } of wordSegments.segment(text)) {
		if (!isWordLike || !/\p{L}/u.test(segment)) continue;
		const word = segment.toLowerCase();
		distinct.add(word);
		total++;
		const repeated = word.length >= 3 && /^([a-z0-9]{1,3})\1+$/.test(word);
		const flagged = flaggedEnds.get(index) === index + segment.length;
		const unlikelySpelling = spelling.has(index) && /^[a-z]+$/.test(word) && score(word) <= markovBaseline.wordThreshold;
		if (repeated || flagged || unlikelySpelling) {
			noisy++;
		} else {
			plausible.add(word);
			if (plausible.size >= 2) return true;
		}
	}
	return distinct.size > 1 && noisy < total * 0.8;
}

function overlaps(a: TextSpan, b: TextSpan) {
	return a.start === b.start || (a.start < b.end && b.start < a.end);
}

/** Flag long runs and adjacent runs of the same letter, while leaving a standalone unit such as mm alone. */
export function repeatedReplacementWords(text: string): TextSpan[] {
	const words = asciiWords(text);
	const flags: TextSpan[] = [];
	for (let start = 0; start < words.length;) {
		const first = words[start];
		if (!/^([a-z])\1+$/i.test(first.text)) { start++; continue; }
		const letter = first.text[0].toLowerCase();
		let end = start + 1;
		let letters = first.text.length;
		for (; end < words.length; end++) {
			const next = words[end];
			if (!/^([a-z])\1+$/i.test(next.text) || next.text[0].toLowerCase() !== letter ||
				!/^[\t ]+$/.test(text.slice(words[end - 1].end, next.start))) break;
			letters += next.text.length;
		}
		if (letters >= 4) flags.push(...words.slice(start, end));
		start = end;
	}
	return flags;
}

/** Give each Markov word its own decision, even if a grammar finding spans several words. */
export function textIssues(text: string, flags: readonly TextSpan[], findings: HarperReview['findings'], choices: readonly Choice[]) {
	const issues: TextIssue[] = flags.map(({ start, end }) => ({ start, end, candidates: [] }));
	// Prefer independent local corrections when a wider grammar suggestion overlaps them.
	for (const finding of [...findings].sort((a, b) => (a.end - a.start) - (b.end - b.start))) {
		if (!finding.suggestions.length) continue;
		const covered = issues.filter(issue => overlaps(issue, finding));
		const targets = covered.length ? covered : [{ start: finding.start, end: finding.end, candidates: [] } as TextIssue];
		for (const target of targets) {
			const original = text.slice(target.start, target.end);
			for (const edit of finding.suggestions) {
				let replacement: string;
				if (edit.start >= target.start && edit.end <= target.end) {
					replacement = text.slice(target.start, edit.start) + edit.replacement + text.slice(edit.end, target.end);
				} else if (edit.start <= target.start && edit.end >= target.end) {
					const prefix = text.slice(edit.start, target.start), suffix = text.slice(target.end, edit.end);
					if (!edit.replacement.startsWith(prefix) || !edit.replacement.endsWith(suffix) ||
						edit.replacement.length < prefix.length + suffix.length) continue;
					replacement = edit.replacement.slice(prefix.length, edit.replacement.length - suffix.length);
				} else continue;
				if (replacement === original || !isWordReplacement(original, replacement)) continue;
				if (!target.candidates.includes(replacement)) target.candidates.push(replacement);
				if (edit.start === target.start && edit.end === target.end && edit.contextScore !== undefined) {
					(target.candidateContextScores ??= Object.create(null))[replacement] = edit.contextScore;
				}
			}
			if (!covered.length && target.candidates.length) issues.push(target);
		}
	}
	// Retain a reported anomaly even when the linter has no automatic edit for it.
	for (const finding of findings) {
		if (!issues.some(issue => overlaps(issue, finding))) {
			issues.push({ start: finding.start, end: finding.end, candidates: [] });
		}
	}
	for (const issue of issues) {
		const chosen = choices.find(choice => choice.start === issue.start && choice.end === issue.end);
		issue.replacement = chosen && (chosen.custom || issue.candidates.includes(chosen.replacement)) ?
			chosen.replacement : flags.some(flag => flag.start === issue.start && flag.end === issue.end) ? undefined : issue.candidates[0];
		if (issue.replacement !== undefined && isMinorCorrection(text.slice(issue.start, issue.end), issue.replacement)) {
			issue.minor = true;
		}
	}
	return issues.sort((a, b) => a.start - b.start || a.end - b.end);
}


export function projectText(raw: string, issues: readonly (TextSpan & { replacement?: string })[]) {
	const changes: TextChange[] = [];
	const parts: string[] = [];
	let end = 0;
	for (const issue of issues) {
		if (issue.replacement === undefined) continue;
		parts.push(raw.slice(end, issue.start), issue.replacement);
		changes.push({ rangeOffset: issue.start, rangeLength: issue.end - issue.start, text: issue.replacement });
		end = issue.end;
	}
	parts.push(raw.slice(end));
	return { text: parts.join(''), changes };
}

// A returned span still consists entirely of untouched source characters.
export function originalSpan(span: TextSpan, changes: readonly TextChange[]): TextSpan | undefined {
	let shift = 0;
	for (const change of changes) {
		const start = change.rangeOffset + shift, end = start + change.text.length;
		if (span.end <= start) break;
		if (span.start < end) return;
		shift += change.text.length - change.rangeLength;
	}
	return { start: span.start - shift, end: span.end - shift };
}
