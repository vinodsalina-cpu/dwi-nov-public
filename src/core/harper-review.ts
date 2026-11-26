import type { HarperHandoff } from './request-review';

type HarperEdit = Readonly<{ start: number; end: number; replacement: string; contextScore?: number }>;
type HarperFinding = Readonly<{
	start: number;
	end: number;
	kind: string;
	message: string;
	suggestions: readonly HarperEdit[];
}>;

export type HarperReview = HarperHandoff & Readonly<{ findings: readonly HarperFinding[] }>;

// Preserve the technical literals protected by the earlier local Harper prototype.
const technicalLiteral = /```[\s\S]*?```|`[^`]*`|https?:\/\/\S+|\b[A-Z][A-Z0-9]{1,}\b|\b\d+(?:\.\d+)?\s*(?:px|ms|mm|cm|km|kg|MB|GB)\b|\b[A-Za-z0-9_]+(?:[.-][A-Za-z0-9_]+)+\b|--[\w-]+|\b\w+_\w+\b|\b[a-z]+[A-Z]\w*\b|\b\w+<[^>\n]+>/g;

export function technicalLiteralRanges(text: string) {
	return Array.from(text.matchAll(technicalLiteral), match => ({ start: match.index, end: match.index + match[0].length }));
}

export async function createHarperReviewer(signal?: AbortSignal) {
	signal?.throwIfAborted();
	const [{ LocalLinter, Dialect, SuggestionKind }, { slimBinary }] = await Promise.all([
		import('harper.js'),
		import('harper.js/slimBinary'),
	]);
	// Await binary setup here so a missing WASM resource is a recoverable operation failure.
	await slimBinary.setup();
	signal?.throwIfAborted();
	const linter = new LocalLinter({ binary: slimBinary, dialect: Dialect.British });

	return {
		async check(handoff: HarperHandoff, cancellation?: AbortSignal): Promise<HarperReview> {
			cancellation?.throwIfAborted();
			const { text, revision } = handoff;
			const protectedRanges = technicalLiteralRanges(text);
			const lints = await linter.lint(text, { language: 'markdown' });
			const findings: HarperFinding[] = [];
			try {
				cancellation?.throwIfAborted();
				for (const lint of lints) {
					const span = lint.span();
					const { start, end } = span;
					span.free();
					if (protectedRanges.some(range => start < range.end && end > range.start)) continue;

					const suggestions = lint.suggestions();
					try {
						const kind = lint.lint_kind();
						// The bundled WASM supplies scores aligned with its existing suggestion order.
						const scores = kind === 'Spelling' && suggestions.length > 1
							? (JSON.parse(lint.to_json()) as { context_scores?: (number | null)[] }).context_scores
							: undefined;
						findings.push({
							start,
							end,
							kind,
							message: lint.message(),
							suggestions: suggestions.map((suggestion, index) => {
								const contextScore = scores?.[index];
								return {
									start: suggestion.kind() === SuggestionKind.InsertAfter ? end : start,
									end,
									replacement: suggestion.get_replacement_text(),
									...(typeof contextScore === 'number' && Number.isFinite(contextScore) ? { contextScore } : {}),
								};
							}),
						});
					} finally {
						for (const suggestion of suggestions) suggestion.free();
					}
				}
			} finally {
				for (const lint of lints) lint.free();
			}
			return { revision, text, findings };
		},
		dispose: () => linter.dispose(),
	};
}
