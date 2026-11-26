import { isMinorCorrection } from './text-review';

type Part = {value: string[]; added?: boolean; removed?: boolean};
const {diffArrays}: {diffArrays(a: string[], b: string[], options?: {timeout: number}): Part[] | undefined} = require('diff');
const tokens = (text: string) => text.match(/[\p{L}\p{M}\p{N}_]+(?:['’][\p{L}\p{M}\p{N}_]+)*|\s+|[^\s]/gu) ?? [];
const graphemes = new Intl.Segmenter(undefined, {granularity: 'grapheme'});
const chars = (s: string) => Array.from(graphemes.segment(s), item => item.segment);

/** UTF-16 ranges in the corrected display only. Never use a visual diff to apply edits. */
export function inputHighlights(original: string, wording: string) {
	const ranges: {start: number; end: number}[] = [];
	if (original === wording) return ranges;
	const parts = diffArrays(tokens(original), tokens(wording), {timeout: 100});
	let offset = 0, removed: string[] = [];
	const mark = (start: number, text: string) => {
		if (text.trim()) ranges.push({start, end: start + text.length});
	};
	for (const part of parts ?? []) {
		if (part.removed) { removed = part.value.filter(s => /[\p{L}\p{N}]/u.test(s)); continue; }
		for (const token of part.value) {
			if (part.added) {
				const previous = /[\p{L}\p{N}]/u.test(token) ? removed.shift() : undefined;
				if (previous && isMinorCorrection(previous, token)) {
					let at = offset;
					for (const piece of diffArrays(chars(previous), chars(token), {timeout: 15}) ?? []) {
						if (piece.removed) continue;
						const text = piece.value.join('');
						if (piece.added) mark(at, text);
						at += text.length;
					}
				} else mark(offset, token);
			}
			offset += token.length;
		}
		removed = [];
	}
	return ranges;
}
