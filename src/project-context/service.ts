import { isDeepStrictEqual } from 'node:util';
import {
  ApprovedContext,
  CheckoutIdentity,
  isApprovedContext,
  isProjectValue,
  isPromptValue,
  isStoredRecord,
  ProjectCandidate,
  ProjectValue,
  RecordHeader,
  RecordKey,
  RecordStore,
  RecordSummary,
  Resolution,
  resolveCandidate,
  StoredRecord,
} from './contracts';
import { reviseProjectSetup } from './setup';

export class ProjectContextError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProjectContextError';
  }
}

export type ProjectContextHost = {
  checkout: CheckoutIdentity;
  promptId(): string;
  now(): string;
  validateContextSource(source: ApprovedContext['sources'][number]): boolean | Promise<boolean>;
};

const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const stableId = (key: string): string => `project-${key}`;

// Slash selections steer work, while the reviewed wording, mapping and attached sources
// determine whether the saved completion still applies. Only ignore the two tag locations
// in the versioned checkpoint. Unknown formats retain their full comparison.
function reviewedCheckpoint(value: unknown): unknown {
  if (!value || typeof value !== 'object' || !('schemaVersion' in value) || value.schemaVersion !== 1 ||
      !('branches' in value) || !Array.isArray(value.branches)) return value;
  const { tags: _tags, ...checkpoint } = value as Record<string, unknown>;
  return { ...checkpoint, branches: value.branches.map((branch: unknown) => {
    if (!branch || typeof branch !== 'object' || !('tags' in branch)) return branch;
    const { tags: _branchTags, ...reviewed } = branch;
    return reviewed;
  }) };
}

function readable(record: StoredRecord | undefined): StoredRecord | undefined {
  if (!record) return undefined;
  if (!isStoredRecord(record)) throw new ProjectContextError('Corrupt record without recoverable history');
  return record;
}

function mutable(record: StoredRecord | undefined): StoredRecord | undefined {
  const current = readable(record);
  if (current?.recovered) throw new ProjectContextError('Recovered records are read-only');
  return current;
}

export class ProjectContextService {
  constructor(private readonly store: RecordStore, private readonly host: ProjectContextHost) {}

  private projectKey(projectId = stableId(this.host.checkout.checkoutKey)): RecordKey {
    return { kind: 'project', projectId };
  }

  private promptKey(projectId: string, promptId: string): RecordKey {
    return { kind: 'prompt', projectId, promptId };
  }

  private summary(title: string, old?: RecordSummary): RecordSummary {
    const now = this.host.now();
    return {
      title,
      createdAt: old?.createdAt ?? now,
      updatedAt: now,
      ...(old?.accessedAt ? { accessedAt: old.accessedAt } : {}),
      ...(old?.archivedAt ? { archivedAt: old.archivedAt } : {}),
      ...(old?.completed !== undefined ? { completed: old.completed } : {}),
    };
  }

  private async write(
    key: RecordKey,
    current: StoredRecord | undefined,
    summary: RecordSummary,
    value: unknown,
  ): Promise<StoredRecord> {
    const result = await this.store.write(key, current?.revision ?? null, { summary, value });
    if (result.kind === 'conflict') throw new ProjectContextError('Concurrent update conflict');
    return result.record;
  }

  async initialize(): Promise<StoredRecord> {
    const key = this.projectKey();
    const prior = readable(await this.store.read(key));
    if (prior) return prior;

    const identity = this.host.checkout;
    const value: ProjectValue = {
      schemaVersion: 1,
      checkoutKey: identity.checkoutKey,
      rootLabel: identity.rootLabel,
      rootLocator: identity.rootLocator,
      ...(identity.fingerprint ? { fingerprint: identity.fingerprint } : {}),
      hiddenPromptIds: [],
    };
    const result = await this.store.write(key, null, {
      summary: this.summary(identity.rootLabel),
      value,
    });
    if (result.kind === 'saved') return result.record;

    const winner = readable(await this.store.read(key));
    if (winner) return winner;
    throw new ProjectContextError('Project initialization conflict; retry');
  }

  async prepareScope(selection: {
    explicitProjectId?: string;
    activeResource?: string;
    candidates: readonly ProjectCandidate[];
  }): Promise<Resolution> {
    return resolveCandidate(selection);
  }

  async approveContext(
    projectId: string,
    reviewed: ApprovedContext,
    currentFingerprint?: string,
    expectedProjectRevision?: number,
  ): Promise<StoredRecord> {
    if (!isApprovedContext(reviewed)) throw new ProjectContextError('Invalid reviewed context');
    if (reviewed.basisFingerprint !== currentFingerprint) {
      throw new ProjectContextError('Context basis changed; review again before approval');
    }

    for (const source of reviewed.sources) {
      if (!await this.host.validateContextSource(source)) {
        throw new ProjectContextError('Context source failed runtime validation');
      }
    }

    const key = this.projectKey(projectId);
    const current = mutable(await this.store.read(key));
    if (!current || !isProjectValue(current.value)) {
      throw new ProjectContextError('Project unavailable or corrupt');
    }
    if (expectedProjectRevision !== undefined && current.revision !== expectedProjectRevision) {
      throw new ProjectContextError('Concurrent update conflict');
    }

    const snapshot = copy(reviewed);
    snapshot.consentedAt = this.host.now();
    const value = { ...current.value, approvedContext: snapshot };
    return this.write(key, current, this.summary(current.summary.title, current.summary), value);
  }

  async saveDraftSetup(projectId: string, draftSetup: unknown): Promise<StoredRecord> {
    return this.updateProject(projectId, project => ({ ...project, draftSetup: copy(draftSetup) }));
  }

  async updateProjectSetup(projectId: string, expectedRevision: number, operation: unknown): Promise<StoredRecord> {
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) {
      throw new ProjectContextError('Invalid project revision');
    }
    return this.updateProject(projectId, project => {
      const draftSetup = reviseProjectSetup(project.draftSetup, operation, () => this.host.promptId());
      return draftSetup === project.draftSetup ? project : { ...project, draftSetup };
    }, expectedRevision);
  }

  private async updateProject(
    projectId: string,
    update: (project: ProjectValue) => ProjectValue,
    expectedRevision?: number,
  ): Promise<StoredRecord> {
    const key = this.projectKey(projectId);
    const record = mutable(await this.store.read(key));
    if (!record || !isProjectValue(record.value)) {
      throw new ProjectContextError('Project unavailable or corrupt');
    }
    if (expectedRevision !== undefined && record.revision !== expectedRevision) {
      throw new ProjectContextError('Concurrent update conflict');
    }
    const value = update(record.value);
    return value === record.value ? record : this.write(key, record, this.summary(record.summary.title, record.summary), value);
  }

  async listProjects(): Promise<RecordHeader[]> {
    return this.store.list('project');
  }

  async readProject(projectId: string): Promise<StoredRecord | undefined> {
    const record = readable(await this.store.read(this.projectKey(projectId)));
    return record && isProjectValue(record.value) ? record : undefined;
  }

  async createPrompt(projectId: string, title: string, checkpoint?: unknown): Promise<StoredRecord> {
    if (!await this.readProject(projectId)) throw new ProjectContextError('Project unavailable');
    const id = this.host.promptId();
    if (!/^[A-Za-z0-9._~-]+$/.test(id)) throw new ProjectContextError('Host returned invalid prompt id');
    return this.write(
      this.promptKey(projectId, id),
      undefined,
      this.summary(title),
      { schemaVersion: 1, ...(checkpoint !== undefined ? { checkpoint: copy(checkpoint) } : {}) },
    );
  }

  async readPrompt(projectId: string, promptId: string): Promise<StoredRecord | undefined> {
    const record = readable(await this.store.read(this.promptKey(projectId, promptId)));
    return record && isPromptValue(record.value) ? record : undefined;
  }

  async savePrompt(
    projectId: string,
    promptId: string,
    checkpoint: unknown,
    title: string | undefined,
    expectedRevision: number,
    agentReadyCopy?: string,
  ): Promise<StoredRecord> {
    const key = this.promptKey(projectId, promptId);
    const record = mutable(await this.store.read(key));
    if (!record || !isPromptValue(record.value)) throw new ProjectContextError('Prompt unavailable or corrupt');
    if (record.revision !== expectedRevision) throw new ProjectContextError('Concurrent update conflict');
    if (record.summary.archivedAt) throw new ProjectContextError('Restore this archived prompt before editing it');
    if (agentReadyCopy !== undefined && !agentReadyCopy.trim()) {
      throw new ProjectContextError('A nonempty, active prompt is required to save an agent-ready copy');
    }

    const summary = this.summary(title ?? record.summary.title, record.summary);
    const value = { ...record.value, checkpoint: copy(checkpoint) };
    if (agentReadyCopy !== undefined) {
      summary.completed = true;
      value.agentReadyCopy = agentReadyCopy;
      value.agentReadyCopyCurrent = true;
    } else if (!isDeepStrictEqual(reviewedCheckpoint(record.value.checkpoint), reviewedCheckpoint(value.checkpoint))) {
      if (summary.completed) summary.completed = false;
      if (value.agentReadyCopy !== undefined) value.agentReadyCopyCurrent = false;
    }

    return this.write(
      key,
      { ...record, revision: expectedRevision },
      summary,
      value,
    );
  }

  async readAgentReadyCopy(projectId: string, promptId: string): Promise<string | undefined> {
    const record = await this.readPrompt(projectId, promptId);
    if (!record || !record.summary.completed || !isPromptValue(record.value)) return;
    const text = record.value.agentReadyCopy;
    if (!text || record.value.agentReadyCopyCurrent === false) return;
    if (record.value.agentReadyCopyCurrent) return text;

    // Older releases kept the last copy when the wording changed. Trace the immutable
    // revisions to distinguish finalizing this checkpoint from manually marking it done.
    let current = record;
    while (current.revision > 1 && this.store.readRevision && isPromptValue(current.value)) {
      const previous = await this.store.readRevision(current.key, current.revision - 1);
      if (!previous || !isPromptValue(previous.value)) return;
      if (previous.value.agentReadyCopy !== text) return text;
      if (!isDeepStrictEqual(reviewedCheckpoint(previous.value.checkpoint), reviewedCheckpoint(current.value.checkpoint))) {
        return current.summary.completed ? text : undefined;
      }
      if (current.summary.completed && !previous.summary.completed && current.summary.updatedAt !== previous.summary.updatedAt) return text;
      if (previous.value.agentReadyCopyCurrent !== undefined) return previous.value.agentReadyCopyCurrent ? text : undefined;
      current = previous;
    }
    return undefined;
  }

  async markComplete(projectId: string, promptId: string, completed = true, expectedRevision?: number): Promise<StoredRecord> {
    return this.updatePrompt(projectId, promptId, record => {
      if (record.summary.archivedAt) throw new ProjectContextError('Restore this archived prompt before changing its completion');
      return { ...record, summary: { ...record.summary, completed } };
    }, expectedRevision);
  }

  async archivePrompt(projectId: string, promptId: string, expectedRevision?: number): Promise<StoredRecord> {
    return this.updatePrompt(projectId, promptId, record => ({
      ...record,
      summary: { ...record.summary, archivedAt: this.host.now() },
    }), expectedRevision);
  }

  async restorePrompt(projectId: string, promptId: string, expectedRevision?: number): Promise<StoredRecord> {
    return this.updatePrompt(projectId, promptId, record => {
      const { archivedAt: _archivedAt, ...summary } = record.summary;
      return { ...record, summary };
    }, expectedRevision);
  }

  async touchPrompt(projectId: string, promptId: string, expectedRevision?: number): Promise<StoredRecord> {
    return this.updatePrompt(projectId, promptId, record => {
      if (record.summary.archivedAt) throw new ProjectContextError('Restore this archived prompt before opening it');
      return { ...record, summary: { ...record.summary, accessedAt: this.host.now() } };
    }, expectedRevision);
  }

  private async updatePrompt(
    projectId: string,
    promptId: string,
    update: (record: StoredRecord) => StoredRecord,
    expectedRevision?: number,
  ): Promise<StoredRecord> {
    const key = this.promptKey(projectId, promptId);
    const record = mutable(await this.store.read(key));
    if (!record) throw new ProjectContextError('Prompt unavailable');
    if (expectedRevision !== undefined && record.revision !== expectedRevision) throw new ProjectContextError('Concurrent update conflict');
    const next = update(record);
    return this.write(key, record, next.summary, next.value);
  }

  async hideRecent(projectId: string, promptId: string, hidden = true): Promise<StoredRecord> {
    return this.updateProject(projectId, project => ({
      ...project,
      hiddenPromptIds: hidden
        ? [...new Set([...project.hiddenPromptIds, promptId])]
        : project.hiddenPromptIds.filter(id => id !== promptId),
    }));
  }

  async listRecents(projectId: string, limit = 20): Promise<RecordHeader[]> {
    const count = Math.max(0, Math.min(100, Math.floor(limit)));
    const project = await this.readProject(projectId);
    if (!project || !isProjectValue(project.value)) return [];
    const projectValue: ProjectValue = project.value;
    const hiddenPromptIds: string[] = projectValue.hiddenPromptIds;
    return (await this.store.list('prompt', projectId))
      .filter(header => !header.summary.archivedAt &&
        !hiddenPromptIds.includes(header.key.kind === 'prompt' ? header.key.promptId : ''))
      .sort((a, b) =>
        (b.summary.accessedAt ?? b.summary.updatedAt).localeCompare(a.summary.accessedAt ?? a.summary.updatedAt))
      .slice(0, count);
  }

  async listPrompts(projectId: string, includeArchived = false): Promise<RecordHeader[]> {
    const project = await this.readProject(projectId);
    if (!project || !isProjectValue(project.value)) return [];
    return (await this.store.list('prompt', projectId))
      .filter(header => includeArchived || !header.summary.archivedAt)
      .sort((a, b) => b.summary.updatedAt.localeCompare(a.summary.updatedAt));
  }

  contextFreshness(project: StoredRecord, fingerprint?: string): 'unknown' | 'fresh' | 'stale' {
    if (!isProjectValue(project.value) || !project.value.approvedContext) return 'unknown';
    const basis = project.value.approvedContext.basisFingerprint;
    if (basis === undefined || fingerprint === undefined) return 'unknown';
    return basis === fingerprint ? 'fresh' : 'stale';
  }
}
