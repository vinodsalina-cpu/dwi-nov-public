import { reviewedSections } from '../core/clarification';
import { restoreClarification, assessmentWording } from '../core/step-three';
import type { ReviewCheckpoint } from '../core/review-workflow';
import { isPromptValue } from './contracts';

export type PromptRef = {projectId: string; promptId: string};
export type RecentPrompt = PromptRef & {title: string; updatedAt: string};
export type RecentAction = 'continue' | 'summarise' | 'archive';
export type PromptSummary = {title: string; lines: {label: string; text: string}[]};

function checkpointOf(value: unknown): Partial<ReviewCheckpoint> | undefined {
	return isPromptValue(value) ? value.checkpoint as Partial<ReviewCheckpoint> | undefined : undefined;
}

export function savedDraftText(value: unknown): string | undefined {
	const text = checkpointOf(value)?.current?.current?.text;
	return typeof text === 'string' && text.trim() ? text : undefined;
}

export function summarisePrompt(title: string, value: unknown): PromptSummary {
	const checkpoint = checkpointOf(value);
	const candidate = Array.isArray(checkpoint?.clarifications)
		? checkpoint.clarifications.find(item => item?.branch === checkpoint?.activeBranch)?.history : undefined;
	const history = restoreClarification(candidate);
	const wording = history && assessmentWording(history).wording;
	const fields = history?.mappingEdits?.wording === wording ? history?.mappingEdits?.fields : undefined;
	const mapping = checkpoint?.proposal?.mapping;
	let sections = fields;
	if (!history && mapping) {
		try { sections = reviewedSections(mapping, mapping.wording); } catch { /* Use saved wording for an older or invalid mapping. */ }
	}
	const excerpt = (text: string, limit: number) => {
		const visual = text.trim();
		return visual.length <= limit ? visual : visual.slice(0, limit - 1).trimEnd() + '…';
	};
	const lines: PromptSummary['lines'] = [];
	for (const [label, entries] of [
		['Objective', sections?.objective], ['Requirements', sections?.requirements], ['Unresolved', sections?.unresolved],
	] as const) {
		const text = Array.isArray(entries) && entries.filter(entry => typeof entry === 'string' && entry.trim()).slice(0, 3).join('\n');
		if (text) lines.push({label, text: excerpt(text, 360)});
	}
	if (!lines.some(line => line.label === 'Objective')) {
		const text = [wording, checkpoint?.proposal?.checkedWording, savedDraftText(value)].find(item => typeof item === 'string' && item.trim());
		if (text) lines.unshift({label: 'Draft excerpt', text: excerpt(text, 360)});
	}
	return { title, lines };
}
