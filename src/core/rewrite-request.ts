import { createEditRequest, createSourceSnapshot } from './edit-contract';
import { technicalLiteralRanges } from './harper-review';
import type { HarperHandoff } from './request-review';

/** Share Harper's technical-literal policy; round matches out to whole graphemes. */
export function createRewriteRequest(draft: HarperHandoff, sourceId: string, jobId: string) {
	const input = { id: sourceId, revision: draft.revision, text: draft.text };
	const source = createSourceSnapshot(input);
	const offsets = source.boundaries.map(boundary => boundary.offset);
	const protectedLiterals = technicalLiteralRanges(draft.text).map((range, index) => ({
		id: `literal${index}`, kind: 'literal' as const,
		start: offsets.filter(offset => offset <= range.start).at(-1)!,
		end: offsets.find(offset => offset >= range.end)!,
	}));
	return createEditRequest(protectedLiterals.length ? createSourceSnapshot({ ...input, protectedLiterals }) : source, jobId);
}
