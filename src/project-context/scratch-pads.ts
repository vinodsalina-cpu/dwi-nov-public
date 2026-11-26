import { randomUUID } from 'node:crypto';
import type { ReviewCheckpoint } from '../core/review-workflow';
import type { PromptValue, StoredRecord } from './contracts';
import { FileRecordStore } from './file-store';
import type { RecentPrompt } from './prompt-recents';
import { ProjectContextError, ProjectContextService } from './service';

export const SCRATCH_SCOPE = 'scratch';

function rootTitle(checkpoint: ReviewCheckpoint): string | undefined {
	// Branch zero is the original draft. Its timeline moves between the active and parked branches.
	const parked = checkpoint.branches.find(branch => branch.id === 0);
	const timeline = checkpoint.activeBranch === 0 ? checkpoint.current : parked?.timeline;
	if (!timeline) return undefined;
	const input = checkpoint.activeBranch === 0 ? checkpoint.input : parked?.input;
	const firstReview = timeline.past.find(draft => draft.reviewed || draft.inTextReview);
	const wording = input?.trim() || firstReview?.text.trim() || timeline.current.text.trim() ||
		timeline.future.find(draft => draft.text.trim())?.text.trim() ||
		timeline.past.slice().reverse().find(draft => draft.text.trim())?.text.trim();
	return wording?.match(/^.{1,100}/u)?.[0].trimEnd();
}

export class ScratchPads {
	private readonly store: FileRecordStore;
	private readonly prompts: ProjectContextService;

	constructor(root: string) {
		this.store = new FileRecordStore(root);
		// Scratch uses the prompt record format in its own store. It needs no project record.
		this.prompts = new ProjectContextService(this.store, {
			checkout: { checkoutKey: SCRATCH_SCOPE, rootLabel: 'Scratch', rootLocator: root },
			now: () => new Date().toISOString(),
			promptId: randomUUID,
			validateContextSource: () => false,
		});
	}

	read(id: string): Promise<StoredRecord | undefined> {
		return this.prompts.readPrompt(SCRATCH_SCOPE, id);
	}

	async save(id: string, revision: number | null, checkpoint: ReviewCheckpoint, agentReadyCopy?: string): Promise<StoredRecord> {
		if (revision !== null) {
			const title = rootTitle(checkpoint);
			return this.prompts.savePrompt(SCRATCH_SCOPE, id, checkpoint, title, revision, agentReadyCopy);
		}

		const now = new Date().toISOString();
		const value: PromptValue = { schemaVersion: 1, checkpoint };
		if (agentReadyCopy !== undefined) {
			if (!agentReadyCopy.trim()) throw new ProjectContextError('An agent-ready copy must contain wording');
			value.agentReadyCopy = agentReadyCopy;
			value.agentReadyCopyCurrent = true;
		}
		const result = await this.store.write({ kind: 'prompt', projectId: SCRATCH_SCOPE, promptId: id }, null, {
			summary: { title: rootTitle(checkpoint) ?? '', createdAt: now, updatedAt: now, completed: agentReadyCopy !== undefined }, value,
		});
		if (result.kind === 'conflict') throw new ProjectContextError('Concurrent update conflict');
		return result.record;
	}

	async list(): Promise<RecentPrompt[]> {
		const rows: RecentPrompt[] = [];
		for (const { key, summary } of await this.store.list('prompt', SCRATCH_SCOPE)) {
			if (key.kind === 'prompt' && summary.title && !summary.completed && !summary.archivedAt) {
				rows.push({ projectId: SCRATCH_SCOPE, promptId: key.promptId, title: summary.title, updatedAt: summary.updatedAt });
			}
		}
		return rows.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || left.promptId.localeCompare(right.promptId));
	}

	archive(id: string, expectedRevision: number): Promise<StoredRecord> {
		return this.prompts.archivePrompt(SCRATCH_SCOPE, id, expectedRevision);
	}
}
