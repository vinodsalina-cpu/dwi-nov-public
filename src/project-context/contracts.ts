/** Portable storage contracts. Keys are identifiers, never filesystem paths. */
export type RecordKey =
  | { kind: 'project'; projectId: string }
  | { kind: 'prompt'; projectId: string; promptId: string };

export type RecordSummary = {
  title: string;
  createdAt: string;
  updatedAt: string;
  accessedAt?: string;
  archivedAt?: string;
  completed?: boolean;
};

export type RecordInput = { summary: RecordSummary; value: unknown };
export type RecordHeader = { key: RecordKey; revision: number; summary: RecordSummary };
export type StoredRecord = RecordHeader & { value: unknown; recovered?: true };
export type WriteResult =
  | { kind: 'saved'; record: StoredRecord }
  | { kind: 'conflict'; current: StoredRecord | undefined };

export interface RecordStore {
  read(key: RecordKey): Promise<StoredRecord | undefined>;
  list(kind: RecordKey['kind'], projectId?: string): Promise<RecordHeader[]>;
  write(key: RecordKey, expectedRevision: number | null, next: RecordInput): Promise<WriteResult>;
}

export type ProjectValue = {
  schemaVersion: 1;
  checkoutKey: string;
  rootLabel: string;
  rootLocator: string;
  fingerprint?: string;
  draftSetup?: unknown;
  approvedContext?: ApprovedContext;
  hiddenPromptIds: string[];
};

export type ContextSource = {
  sourceId?: string;
  kind?: 'inline';
  reference: string;
  excerpt: string;
  capturedAt: string;
  fingerprint?: string;
};
export type ApprovedContext = {
  consentedAt: string;
  basisFingerprint?: string;
  sources: ContextSource[];
};
export type PromptValue = { schemaVersion: 1; checkpoint?: unknown; agentReadyCopy?: string };
export type CheckoutIdentity = {
  checkoutKey: string;
  rootLabel: string;
  rootLocator: string;
  fingerprint?: string;
};

/** Host metadata remains available to integrations; core never infers paths. */
export type ProjectCandidate = {
  projectId: string;
  location: string;
  active: boolean;
  containsActiveResource?: boolean;
  depth?: number;
  [field: string]: unknown;
};

export type CandidateResolution = {
  explicitProjectId?: string;
  activeResource?: string;
  candidates: readonly ProjectCandidate[];
};
export type Resolution =
  | { kind: 'resolved'; projectId: string; reason: 'explicit' | 'deepest-active' | 'sole' }
  | { kind: 'ambiguous' | 'unavailable' };

const object = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown): v is string => typeof v === 'string';
const date = (v: unknown): v is string => str(v) && Number.isFinite(Date.parse(v));

export function isRecordKey(v: unknown): v is RecordKey {
  if (!object(v) || !str(v.projectId) || !/^[A-Za-z0-9._~-]+$/.test(v.projectId)) return false;
  return v.kind === 'project' ||
    (v.kind === 'prompt' && str(v.promptId) && /^[A-Za-z0-9._~-]+$/.test(v.promptId));
}

export function isRecordSummary(v: unknown): v is RecordSummary {
  return object(v) && str(v.title) && date(v.createdAt) && date(v.updatedAt) &&
    (v.accessedAt === undefined || date(v.accessedAt)) &&
    (v.archivedAt === undefined || date(v.archivedAt)) &&
    (v.completed === undefined || typeof v.completed === 'boolean');
}

export function isStoredRecord(v: unknown): v is StoredRecord {
  return object(v) && isRecordKey(v.key) && Number.isSafeInteger(v.revision) &&
    (v.revision as number) > 0 && isRecordSummary(v.summary) &&
    Object.prototype.hasOwnProperty.call(v, 'value') &&
    (v.recovered === undefined || v.recovered === true);
}

export function isContextSource(v: unknown): v is ContextSource {
  return object(v) && str(v.reference) && str(v.excerpt) && date(v.capturedAt) &&
    (v.sourceId === undefined || (str(v.sourceId) && /^[A-Za-z0-9._~-]{1,200}$/.test(v.sourceId))) &&
    (v.kind === undefined || (v.kind === 'inline' && v.sourceId !== undefined)) &&
    (v.fingerprint === undefined || str(v.fingerprint));
}

export function isApprovedContext(v: unknown): v is ApprovedContext {
  return object(v) && date(v.consentedAt) &&
    (v.basisFingerprint === undefined || str(v.basisFingerprint)) &&
    Array.isArray(v.sources) && v.sources.every(isContextSource);
}

export function isProjectValue(v: unknown): v is ProjectValue {
  if (!object(v) || v.schemaVersion !== 1 || !str(v.checkoutKey) || !str(v.rootLabel) ||
      !str(v.rootLocator) || !Array.isArray(v.hiddenPromptIds) || !v.hiddenPromptIds.every(str)) {
    return false;
  }
  if (v.fingerprint !== undefined && !str(v.fingerprint)) return false;
  if (v.approvedContext !== undefined && !isApprovedContext(v.approvedContext)) return false;
  return true;
}

export function isPromptValue(v: unknown): v is PromptValue {
  return object(v) && v.schemaVersion === 1 && (v.agentReadyCopy === undefined || str(v.agentReadyCopy));
}

export function resolveCandidate(input: CandidateResolution): Resolution {
  const eligible = input.candidates;
  if (input.explicitProjectId && eligible.some(c => c.projectId === input.explicitProjectId)) {
    return { kind: 'resolved', projectId: input.explicitProjectId, reason: 'explicit' };
  }

  const matches = eligible.filter(candidate => candidate.active && candidate.containsActiveResource);
  if (matches.length) {
    const depth = Math.max(...matches.map(candidate => candidate.depth ?? 0));
    const deepest = [...new Set(matches
      .filter(candidate => (candidate.depth ?? 0) === depth)
      .map(candidate => candidate.projectId))];
    if (deepest.length === 1) return { kind: 'resolved', projectId: deepest[0], reason: 'deepest-active' };
    if (deepest.length > 1) return { kind: 'ambiguous' };
  }

  const unique = [...new Set(eligible.map(candidate => candidate.projectId))];
  if (unique.length === 1) return { kind: 'resolved', projectId: unique[0], reason: 'sole' };
  return unique.length ? { kind: 'ambiguous' } : { kind: 'unavailable' };
}
