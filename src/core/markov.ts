import model from '../../vendor/gibb-model.json';

export type TextSpan = Readonly<{ start: number; end: number }>;
export type MarkovWord = TextSpan & Readonly<{ text: string; score: number }>;
export type MarkovFinding = TextSpan & Readonly<{
	score: number;
	suspiciousWords: readonly MarkovWord[];
}>;

type MarkovConfig = Readonly<{
	wordThreshold: number;
	minSuspiciousWords: number;
	minWordLength: number;
	windowSizes: readonly number[];
	windowMultiplier: number;
}>;
export type MarkovOptions = Partial<MarkovConfig>;

export const markovBaseline: MarkovConfig = Object.freeze({
	wordThreshold: 0.018782003473122023,
	minSuspiciousWords: 2,
	minWordLength: 4,
	windowSizes: Object.freeze([2, 3, 4]),
	windowMultiplier: 0.35,
});

// Adapted from dwi-v2/src/core/noise.ts and gibb 1.0.3 (MIT, vendor/gibb-LICENSE).
export function score(text: string): number {
	const alphabet = 'abcdefghijklmnopqrstuvwxyz ';
	const chars = [...text.toLowerCase()].filter(char => alphabet.includes(char));
	let total = 0;
	for (let i = 1; i < chars.length; i++) {
		total += model.mat[alphabet.indexOf(chars[i - 1])][alphabet.indexOf(chars[i])];
	}
	return Math.exp(total / Math.max(1, chars.length - 1));
}

export function asciiWords(text: string) {
	return [...text.matchAll(/[A-Za-z]+/g)].map(match => ({
		start: match.index,
		end: match.index + match[0].length,
		text: match[0],
	}));
}

/** Returns qualifying windows in original UTF-16 offsets, including overlapping windows. */
export function detectMarkov(text: string, options: MarkovOptions = {}): MarkovFinding[] {
	const config = { ...markovBaseline, ...options };
	const words = asciiWords(text).map(word => ({ ...word, score: score(word.text) }));
	const findings: MarkovFinding[] = [];
	for (let i = 0; i < words.length; i++) {
		for (const size of config.windowSizes) {
			if (!Number.isInteger(size) || size < 1 || i + size > words.length) continue;
			const start = words[i].start;
			const end = words[i + size - 1].end;
			const segment = text.slice(start, end);
			if (/[.!?\r\n\u0000]/.test(segment)) continue;
			const suspiciousWords = words.slice(i, i + size).filter(word =>
				word.text.length >= config.minWordLength && word.score <= config.wordThreshold,
			);
			if (suspiciousWords.length < config.minSuspiciousWords) continue;
			const windowScore = score(segment);
			if (windowScore / config.wordThreshold <= config.windowMultiplier) {
				findings.push({ start, end, score: windowScore, suspiciousWords });
			}
		}
	}
	return findings;
}
