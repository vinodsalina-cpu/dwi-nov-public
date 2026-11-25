import type { HarperReview } from './harper-review';
import type { TextSpan } from './markov';

type Advisory = TextSpan & (
	| Readonly<{ source: 'Markov'; message: string }>
	| Readonly<{ source: 'Harper'; message: string; finding: number; suggestions: HarperReview['findings'][number]['suggestions'] }>
);
type PreviewGroup = { start: number; end: number; advice: Advisory[] };

export function combinePreview(
	markov: readonly TextSpan[],
	harper: HarperReview['findings'],
): readonly PreviewGroup[] {
	const ranges: Advisory[] = [
		...markov.map(({ start, end }) => ({
			start, end, source: 'Markov' as const, message: 'Unusual letter pattern.',
		})),
		...harper.map(({ start, end, message, suggestions }, finding) => ({
			start, end, source: 'Harper' as const, message, suggestions, finding,
		})),
	];
	ranges.sort((a, b) => a.start - b.start || b.end - a.end);

	const groups: PreviewGroup[] = [];
	for (const advice of ranges) {
		const { start, end } = advice;
		const last = groups.at(-1);
		// Keep adjacent ranges separate. At a shared start, include insertion advice.
		if (last && (start < last.end || start === last.start)) {
			last.end = Math.max(last.end, end);
			// A long Harper span may cover multiple distinct Markov words.
			const previous = last.advice.at(-1);
			if (advice.source !== 'Markov' || previous?.source !== 'Markov' || previous.start !== start || previous.end !== end) {
				last.advice.push(advice);
			}
		} else {
			groups.push({ start, end, advice: [advice] });
		}
	}
	return groups;
}
