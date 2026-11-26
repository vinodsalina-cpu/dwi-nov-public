import { clarificationQuestions, type Answer } from './clarification';
import type { LogCapture } from './review-logs';
import { stepId } from './step-id';
import type { HistorySide } from './action-history';
import { hasPlausibleWording, isWordReplacement, meetsDraftMinimums, originalSpan, parseWordReplacement, projectText,
	repeatedReplacementWords, replacementCaseMismatch, textIssues, type TextIssue } from './text-review';
import { combinePreview } from './draft-preview';
import { createHarperReviewer, type HarperReview } from './harper-review';
import { QwenRewriteError, rewriteWithQwen } from './qwen-rewrite';
import { mapPrompt, readPromptMapping, taskLabel, taskLabels, type PromptMapping } from './prompt-mapping';
import { RequestReview, type DraftSnapshot, type DraftTimeline, type HarperHandoff, type TextChange } from './request-review';
import { applyEditResult, createEditRequest, createSourceSnapshot, sourceRef, type AppliedSkillResult, type EditRequest, type Provenance, type SourceSnapshot } from './edit-contract';
import { createRewriteRequest } from './rewrite-request';
import type { ContextSource } from './context-sources';
import { answerInput, validateAnswer, type FileAnswer } from './question-input';
import { activeDecisions, assessStepThree, assessmentWording, commitAnswer, newHistory, restoreClarification, saveStepThreeMapping,
	type ClarificationHistory, type Reference, type Response, type StepThreeServices, type StepThreeState } from './step-three';

const noContext: readonly ContextSource[] = Object.freeze([]);

export type ReviewServices = Readonly<{
	harper: (draft: HarperHandoff, signal: AbortSignal) => Promise<HarperReview>;
	rewrite: (request: EditRequest, signal: AbortSignal) => Promise<unknown>;
	mapPrompt?: typeof mapPrompt;
	stepThree?: StepThreeServices;
}>;

export const localServices: ReviewServices = {
	async harper(draft, signal) {
		const reviewer = await createHarperReviewer(signal);
		try {
			signal.throwIfAborted();
			return await reviewer.check(draft, signal);
		} finally {
			await reviewer.dispose();
		}
	},
	rewrite: rewriteWithQwen,
};

type Checked = HarperReview & { groups: ReturnType<typeof combinePreview> };
type AppliedRewrite = Extract<AppliedSkillResult, { kind: 'proposal' | 'unchanged' }>;
type RewriteOutcome = { source: SourceSnapshot; result: Exclude<AppliedSkillResult, AppliedRewrite> };
type Ready = ({ phase: 'ready' } | { phase: 'harper-reviewed'; harper: Checked }) & { rewriteOutcome?: RewriteOutcome };
type WordingReview = { wording: string; status: 'checking' | 'ready' | 'failed'; groups: Checked['groups'] };
type Proposal = HarperHandoff & { id: number; proposed: string; checkedWording?: string; previousWordings?: string[];
	source: SourceSnapshot; result: AppliedRewrite; review: WordingReview; restoredConfirmationKind?: 'proposal' | 'source' | 'edited' };
type Mapped = { answers?: Answer[]; status: 'mapped' | 'needs-revision'; frame: PromptMapping; editVersion: number; parsed: PromptMapping };
type MappingResult = { status: 'checking' } | Mapped
	| { status: 'failed'; message: string };
type MappingCheck = { id: string; proposal: Proposal; controller: AbortController; result: MappingResult };
function mappingStatus(frame: PromptMapping): Mapped['status'] {
	return !frame.task_intents.length || frame.needs_context || frame.unresolved.length ? 'needs-revision' : 'mapped';
}
type ProposedStage = {phase: 'proposal'; base: Ready; rewrite: Proposal};
type RewriteJob = { phase: 'rewriting'; controller: AbortController; base: Ready; previous?: ProposedStage; request: EditRequest; reviewBase: DraftTimeline };
type ActiveJob = { phase: 'checking-harper' } | RewriteJob;
type Stage = Ready | ActiveJob
	| ProposedStage
	| { phase: 'confirmed'; base: Ready; rewrite: Proposal & { confirmed: string } };
type RestoredProposal = ProposedStage | Extract<Stage, {phase: 'confirmed'}>;
type ReviewBatch = { status: 'checking' | 'ready' | 'needs-text' | 'failed'; issues: TextIssue[] };
type DraftTags = Readonly<{task?: typeof taskLabels[number]; criticality?: 'low' | 'medium' | 'high'}>;
function validTags(value: unknown): value is DraftTags {
	return record(value) && Object.keys(value).every(key => key === 'task' || key === 'criticality') &&
		(value.task === undefined || taskLabel(value.task)) &&
		(value.criticality === undefined || value.criticality === 'low' || value.criticality === 'medium' || value.criticality === 'high');
}
type SavedBranch = { tags?: DraftTags; timeline: DraftTimeline; stage: Exclude<Stage, ActiveJob>; title: string; copyKey?: string; input?: string; batch?: ReviewBatch; proposalBase?: DraftTimeline };
type ProposalCheckpoint = Readonly<{ source: {id: string; revision: number; text: string}; envelope: unknown; reviewBase: DraftTimeline;
	previousWordings: readonly string[]; proposed: string; checkedWording?: string; review: {wording: string; status: 'ready' | 'failed'; groups: Checked['groups']};
	confirmed?: string; confirmationKind?: 'proposal' | 'source' | 'edited'; mapping?: {wording: string; parsed: PromptMapping; frame: PromptMapping; answers?: Answer[]; editVersion: number} }>;

/** Versioned JSON-safe user work. Runtime engines, jobs, and derived checks are deliberately absent. */
export type ReviewCheckpoint = Readonly<{
	schemaVersion: 1;
	tags?: DraftTags;
	initial: DraftSnapshot;
	current: DraftTimeline;
	activeBranch: number;
	branches: readonly Readonly<{ id: number; tags?: DraftTags; timeline: DraftTimeline; title: string; copyKey?: string; input?: string; contextSources?: readonly ContextSource[] }> [];
	copyKey?: string;
	input?: string;
	contextSources: readonly ContextSource[];
	interrupted: boolean;
	proposal?: ProposalCheckpoint;
	clarifications?: readonly { branch: number; history: ClarificationHistory }[];
}>;

export type WorkerInput = Readonly<{
	tags?: DraftTags;
	version: number; revision: number; proposalId: number; sourceText: string; wording: string;
	approval: Readonly<{ kind: 'proposal' | 'source' | 'edited'; jobId: string; source: ReturnType<typeof sourceRef> }>;
	changes: readonly TextChange[]; provenance: readonly Provenance[]; editResult: AppliedRewrite;
	mapping?: PromptMapping;
}>;
export type ReviewCommand = { type: 'sync' } | (Readonly<{ version: number; revision: number }> & (
	| { type: 'edit'; text: string }
	| { type: 'set-draft-tags'; tags: DraftTags; previous: DraftTags; stepId: string }
	| { type: 'next' | 'start-review' | 'rewrite-reviewed' | 'use-reviewed-wording' | 'retry-text-review' }
	| { type: 'choose'; start: number; end: number; replacement: string; custom?: boolean; apply?: boolean }
	| { type: 'replacement-clipped'; start: number; end: number }
	| { type: 'check-mapping' | 'rewrite-input'; proposalId: number; wording: string }
	| { type: 'back-from-mapping'; proposalId: number }
	| { type: 'answer-question'; proposalId: number; frameId: string; editVersion: number; questionId: string; answer: string }
	| { type: 'save-mapping'; proposalId: number; frameId: string; editVersion: number; frame: PromptMapping }
	| { type: 'review' | 'undo' | 'redo' | 'restore' | 'harper' | 'rewrite' | 'cancel' }
	| { type: 'drop-action'; side: HistorySide; index: number }
	| { type: 'open-branch' | 'discard-branch'; id: number }
	| { type: 'open-copy'; key: string; base: string; text: string }
	| { type: 'correct'; start: number; text: string }
	| { type: 'keep'; start: number; scope: 'occurrence' | 'term'; reason?: string }
	| { type: 'validate'; start: number; end: number; scope: 'occurrence' | 'term'; reason?: string }
	| { type: 'revoke'; id: number }
	| { type: 'apply-harper'; finding: number; suggestion: number }
	| { type: 'confirm-rewrite'; proposalId: number; wording: string }
	| { type: 'keep-draft'; proposalId: number }
	| { type: 'resume-clarification' }
	| { type: 'review-step-three-wording'; proposalId: number; wording: string }
	| { type: 'navigate-clarification'; questionId: string; position: number }
	| { type: 'submit-clarification'; questionId: string; input?: unknown; skip?: boolean }
	| { type: 'save-step-three-mapping'; frameId: string; editVersion: number; fields: unknown }
));
export type CommandResult = Readonly<{
	status: 'accepted' | 'stale' | 'blocked' | 'invalid'; notice?: string;
}>;
const accepted: CommandResult = Object.freeze({ status: 'accepted' });
const blocked: CommandResult = Object.freeze({ status: 'blocked', notice: 'That action is unavailable for the current draft.' });
const invalid: CommandResult = Object.freeze({ status: 'invalid', notice: 'The review action was invalid.' });

function record(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function index(value: unknown): value is number {
	return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}
const categories = ['rules', 'repository', 'documents', 'connectors', 'mcp', 'working-memory'];
function validSpan(text: string, value: unknown): boolean {
	return record(value) && index(value.start) && index(value.end) && value.start < value.end && value.end <= text.length &&
		typeof value.text === 'string' && text.slice(value.start, value.end) === value.text &&
		(value.score === undefined || typeof value.score === 'number' && Number.isFinite(value.score));
}
function validDraftSnapshot(value: unknown): value is DraftSnapshot {
	if (!record(value) || typeof value.text !== 'string' || !Array.isArray(value.approvals) || !Array.isArray(value.choices) ||
		!Array.isArray(value.repeatedWords) || typeof value.inTextReview !== 'boolean' || typeof value.reviewed !== 'boolean') return false;
	const approvalIds = new Set<number>();
	for (const approval of value.approvals) {
		if (!record(approval) || !index(approval.id) || approvalIds.has(approval.id) || !validSpan(value.text, approval.word) ||
			!['term', 'occurrence'].includes(String(approval.scope)) || (approval.advisory !== undefined && approval.advisory !== true) ||
			(approval.reason !== undefined && typeof approval.reason !== 'string')) return false;
		approvalIds.add(approval.id);
	}
	const spans = (items: unknown[]) => items.every(item => validSpan(value.text as string, item));
	if (!spans(value.repeatedWords)) return false;
	const choiceKeys = new Set<string>();
	for (const choice of value.choices) {
		if (!validSpan(value.text, choice) || typeof choice.replacement !== 'string' || typeof choice.custom !== 'boolean') return false;
		const key = `${choice.start}:${choice.end}`;
		if (choiceKeys.has(key)) return false;
		choiceKeys.add(key);
	}
	return true;
}

// Include every possible location of an ambiguous single edit in the affected span.
function changedSpan(before: string, after: string): TextChange {
	const shared = Math.min(before.length, after.length);
	let head = 0, tail = 0;
	while (head < shared && before[head] === after[head]) head++;
	while (tail < shared && before[before.length - tail - 1] === after[after.length - tail - 1]) tail++;
	const start = Math.min(head, shared - tail);
	const suffix = Math.min(tail, shared - head);
	return { rangeOffset: start, rangeLength: before.length - start - suffix, text: after.slice(start, after.length - suffix) };
}

function validHarper(draft: HarperHandoff, review: HarperReview): boolean {
	const span = (start: unknown, end: unknown) => index(start) && index(end) && start <= end && end <= draft.text.length;
	if (review?.revision !== draft.revision || review.text !== draft.text || !Array.isArray(review.findings)) return false;
	for (const finding of review.findings) {
		if (!finding || !span(finding.start, finding.end) || typeof finding.message !== 'string' ||
			typeof finding.kind !== 'string' || !Array.isArray(finding.suggestions)) return false;
		for (const edit of finding.suggestions) {
			if (!edit || !span(edit.start, edit.end) || typeof edit.replacement !== 'string') return false;
		}
	}
	return true;
}

/** One session owns the Markov gate, all foreground effects and the confirmed worker input. */
export class ReviewWorkflow {
	private readonly sourceId = stepId();
	private readonly rewriteBases = new WeakMap<AppliedRewrite, DraftTimeline>();
	private rewriteCheck?: { id: string; proposalId: number };
	private readonly branches = new Map<number, SavedBranch>();
	private nextBranch = 0;
	private activeBranch = 0;
	private tags?: DraftTags;
	private readonly traceIds = new Map<number, string[]>();
	get stepIds() {
		let ids = this.traceIds.get(this.activeBranch);
		if (!ids) { ids = [stepId(), stepId(), stepId()]; this.traceIds.set(this.activeBranch, ids); }
		return ids;
	}
	private activeCopyKey?: string;
	private readonly draft = new RequestReview('', {}, abandoned => {
		this.park(abandoned, { phase: 'ready' }, null);
		this.activeBranch = ++this.nextBranch;
		this.activeCopyKey = undefined;
	}, run => { const step = this.draft.inTextReview ? 2 : 1; this.capture?.(this.stepIds[step - 1], step, this.draft.revision, 'Draft', run); });
	private stage: Stage = { phase: 'ready' }; // Downstream state is visible only while Markov is clear.
	private version = 0;
	private notice?: string;
	private readonly listeners = new Set<() => void>();
	private lint?: { revision: number; text: string; controller: AbortController; result: Promise<HarperReview> };
	private lintTail = Promise.resolve();
	private entryStatus?: 'checking' | 'allowed' | 'noise' | 'failed';
	private batch?: ReviewBatch;
	private input?: string;
	private mapping?: MappingCheck;
	private readonly sessionMappings = new WeakMap<AppliedRewrite, {wording: string; result: Mapped}>();
	private readonly clarifications = new Map<number, StepThreeState>();
	private readonly pickedFiles = new Map<string, readonly FileAnswer[]>();
	private assessment?: { branch: number; controller: AbortController };
	private assessmentTail: Promise<void> = Promise.resolve();
	private restoredClarification = false;
	private get stepThree() { return this.clarifications.get(this.activeBranch); }
	private get visibleClarification() {
		const state = this.stepThree;
		if (!this.services.stepThree || !state) return;
		if (this.stage.phase === 'proposal' || this.stage.phase === 'confirmed') {
			const review = this.stage.rewrite.review;
			return state.history.wording === review.wording && review.status !== 'checking' ? state : undefined;
		}
		return this.restoredClarification ? state : undefined;
	}
	private readonly thingsToNotify: Array<{ kind: 'multiple-words' | 'casing-mismatch'; branch: number;
		revision: number; start: number; end: number }> = [];
	readReplacementAttempts() { return structuredClone(this.thingsToNotify); }

	private noteReplacement(kind: 'multiple-words' | 'casing-mismatch', start: number, end: number) {
		this.thingsToNotify.push({kind, branch: this.activeBranch, revision: this.draft.revision, start, end});
	}

	private parseReplacement(value: string, start: number, end: number) {
		const {word, multiple} = parseWordReplacement(value);
		if (multiple) this.noteReplacement('multiple-words', start, end);
		return word;
	}
	get submittedInput() { return this.input ?? (this.draft.inTextReview || this.draft.state === 'ready' ? this.draft.text : undefined); }
	actionList(side: HistorySide) { return this.draft.actionList(side); }
	get branchId() { return this.activeBranch; }
	private readonly sourcesByBranch = new Map<number, readonly ContextSource[]>();
	get contextSources() { return this.sourcesByBranch.get(this.branchId) ?? noContext; }
	setContextSources(branch: number, previous: readonly ContextSource[], sources: readonly ContextSource[]): boolean {
		if (this.branchId !== branch || this.contextSources !== previous) return false;
		if (sources.length) this.sourcesByBranch.set(branch, sources);
		else this.sourcesByBranch.delete(branch);
		if (this.visibleClarification && this.visibleClarification.status !== 'blocked') this.assessClarification(this.visibleClarification, true);
		else this.commit(this.notice);
		return true;
	}
	private refreshTimer?: NodeJS.Timeout;
	private lastPreview?: { version: number; groups: Checked['groups'] };

	constructor(private readonly services: ReviewServices = localServices, private readonly capture?: LogCapture) {}

	exportCheckpoint(): ReviewCheckpoint {
		const saved = [...this.branches].map(([id, branch]) => ({ ...(branch.tags && {tags: branch.tags}), id, timeline: branch.timeline, title: branch.title,
			...(this.sourcesByBranch.has(id) && {contextSources: this.sourcesByBranch.get(id)}),
			...(branch.copyKey !== undefined && {copyKey: branch.copyKey}), ...(branch.input !== undefined && {input: branch.input}),
			...('rewrite' in branch.stage && {proposal: this.proposalCheckpoint(branch.stage, branch.proposalBase)}) }));
		return structuredClone({ ...(this.tags && {tags: this.tags}), schemaVersion: 1, initial: this.draft.checkpointInitial(), current: this.draft.timeline(),
			activeBranch: this.activeBranch, branches: saved, input: this.input, contextSources: this.contextSources,
			...(this.activeBranch !== 0 && {copyKey: this.activeCopyKey}),
			...(this.clarifications.size && {clarifications: [...this.clarifications].map(([branch, state]) => ({branch, history: state.history}))}),
			...('rewrite' in this.stage && {proposal: this.proposalCheckpoint(this.stage)}),
			interrupted: this.stage.phase === 'rewriting' || this.stage.phase === 'checking-harper' ||
				this.batch?.status === 'checking' || this.entryStatus === 'checking' || this.mapping?.result.status === 'checking' || this.rewriteCheck !== undefined });
	}

	private proposalCheckpoint(stage: ProposedStage | Extract<Stage, {phase: 'confirmed'}>, rewriteBase?: DraftTimeline): ProposalCheckpoint {
		const proposal = stage.rewrite;
		const mapping = this.sessionMappings.get(proposal.result);
		const review = proposal.review.status === 'checking' ? { ...proposal.review, status: 'failed' as const } : proposal.review;
		return { source: {id: proposal.source.id, revision: proposal.source.revision, text: proposal.source.text}, envelope: {
			schemaVersion: 1, jobId: proposal.result.jobId, source: sourceRef(proposal.source),
			...(proposal.result.kind === 'proposal' ? {kind: 'proposal', edits: proposal.result.edits} : {kind: 'unchanged'}),
			...(proposal.result.obligations && {obligations: proposal.result.obligations}) },
			reviewBase: rewriteBase ?? this.rewriteBases.get(proposal.result)!, previousWordings: proposal.previousWordings ?? [], proposed: proposal.proposed,
			...(proposal.checkedWording !== undefined && {checkedWording: proposal.checkedWording}),
			review: {wording: review.wording, status: review.status === 'ready' ? 'ready' : 'failed', groups: review.groups},
			...('confirmed' in proposal && {confirmed: proposal.confirmed, confirmationKind: proposal.restoredConfirmationKind ??
				(proposal.confirmed === proposal.text ? 'source' : proposal.confirmed === proposal.result.text ? 'proposal' : 'edited')}),
			...(mapping && mapping.wording === proposal.checkedWording && {mapping: {
				wording: mapping.wording, parsed: mapping.result.parsed, frame: mapping.result.frame, answers: mapping.result.answers,
				editVersion: mapping.result.editVersion}}) };
	}

	private buildRestoredProposal(saved: ProposalCheckpoint, timelineText: string, title: string): RestoredProposal | undefined {
		if (!record(saved) || !record(saved.source) || typeof saved.source.id !== 'string' || !index(saved.source.revision) ||
			typeof saved.source.text !== 'string' || !Array.isArray(saved.previousWordings) ||
			!saved.previousWordings.every(wording => typeof wording === 'string') || typeof saved.proposed !== 'string' || !saved.proposed.trim() ||
			!record(saved.reviewBase) || !validDraftSnapshot(saved.reviewBase.current) || !Array.isArray(saved.reviewBase.past) ||
			!saved.reviewBase.past.every(validDraftSnapshot) || !Array.isArray(saved.reviewBase.future) || !saved.reviewBase.future.every(validDraftSnapshot) ||
			!record(saved.review) || typeof saved.review.wording !== 'string' || !['ready', 'failed'].includes(String(saved.review.status)) ||
			!Array.isArray(saved.review.groups) || (saved.checkedWording !== undefined && typeof saved.checkedWording !== 'string') ||
			(saved.confirmed !== undefined && (typeof saved.confirmed !== 'string' || !['proposal','source','edited'].includes(String(saved.confirmationKind))))) return;
		const source = createSourceSnapshot({id: saved.source.id, revision: saved.source.revision, text: saved.source.text});
		const envelope = saved.envelope;
		if (!record(envelope) || typeof envelope.jobId !== 'string' || !envelope.jobId.length) return;
		const request = createEditRequest(source, envelope.jobId);
		const applied = applyEditResult(request, envelope);
		if (!applied.ok || (applied.value.kind !== 'proposal' && applied.value.kind !== 'unchanged') ||
			applied.value.text !== saved.proposed || saved.reviewBase.current.text !== saved.source.text ||
			!([saved.source.text, ...saved.previousWordings].includes(timelineText))) return;
		const result = applied.value;
		this.rewriteBases.set(result, structuredClone(saved.reviewBase));
		const baseDraft = {text: saved.source.text, revision: 0};
		const proposal: Proposal = { ...baseDraft, id: 1, proposed: result.text, source, result,
			previousWordings: [...saved.previousWordings], ...(saved.checkedWording !== undefined && {checkedWording: saved.checkedWording}),
			review: {wording: saved.review.wording, status: 'failed', groups: structuredClone(saved.review.groups)} };
		if (saved.review.groups.some(group => {
			if (!record(group) || !index(group.start) || !index(group.end) || group.start > group.end ||
				group.end > saved.review.wording.length || !Array.isArray(group.advice)) return true;
			return group.advice.some(advice => !record(advice) || !index(advice.start) || !index(advice.end) ||
				advice.start > advice.end || advice.end > saved.review.wording.length ||
				(advice.source !== 'Markov' && advice.source !== 'Harper') || typeof advice.message !== 'string');
		})) return;
		let stage: RestoredProposal = {phase: 'proposal', base: {phase: 'ready'}, rewrite: proposal};
		if (saved.mapping !== undefined) {
			const value = saved.mapping;
			if (!record(value) || typeof value.wording !== 'string' || value.wording !== saved.checkedWording || !index(value.editVersion) ||
				!Array.isArray(value.answers) && value.answers !== undefined) return;
			const parsed = readPromptMapping(value.parsed, value.wording, 'restored-parsed', 'parser');
			const frameId = typeof value.frame?.id === 'string' ? value.frame.id : '';
			if (!frameId) return;
			const frame = readPromptMapping(value.frame, value.wording, frameId, 'developer');
			const questions = clarificationQuestions({frame, parsed});
			const answers = value.answers?.map(answer => {
				if (!record(answer) || typeof answer.questionId !== 'string' || typeof answer.text !== 'string' || !answer.text.trim() ||
					!questions.some(question => question.id === answer.questionId)) throw new Error('invalid answer');
				return {questionId: answer.questionId, text: answer.text};
			});
			if (answers && new Set(answers.map(answer => answer.questionId)).size !== answers.length) return;
			const mapped: Mapped = { status: answers?.length && questions.every(question => answers.some(answer => answer.questionId === question.id)) && frame.actions.length
				? 'mapped' : mappingStatus(frame), parsed, frame, answers, editVersion: value.editVersion };
			this.sessionMappings.set(result, {wording: value.wording, result: mapped});
		}
		if (saved.confirmed !== undefined) {
			const kind = saved.confirmationKind!;
			const provenance = kind === 'proposal' ? result.provenance : [{output:{start:0,end:saved.confirmed.length},source:kind === 'source' ? {start:0,end:saved.source.text.length} : null}];
			const changes = kind === 'proposal' ? result.changes : kind === 'source' ? [] : [{rangeOffset:0,rangeLength:saved.source.text.length,text:saved.confirmed}];
			const validCoverage = provenance.length > 0 && provenance[0].output.start === 0 && provenance.at(-1)!.output.end === saved.confirmed.length &&
				provenance.every((part, index) => part.output.start < part.output.end && part.output.end <= saved.confirmed!.length &&
					(index === 0 || provenance[index - 1].output.end === part.output.start) &&
					(part.source === null || part.source.start >= 0 && part.source.start < part.source.end && part.source.end <= saved.source.text.length &&
						saved.confirmed!.slice(part.output.start, part.output.end) === saved.source.text.slice(part.source.start, part.source.end)));
			if (!saved.confirmed.trim() || !validCoverage || kind === 'proposal' && saved.confirmed !== result.text ||
				kind === 'source' && saved.confirmed !== timelineText || kind === 'edited' && (changes[0].rangeOffset !== 0 || changes[0].rangeLength !== saved.source.text.length || changes[0].text !== saved.confirmed)) return;
		stage = {phase:'confirmed', base:{phase:'ready'}, rewrite:{...proposal, confirmed:saved.confirmed, restoredConfirmationKind:kind}};
		}
		return stage;
	}

	/** Validates the complete serialized shape before cancelling or replacing the live session. */
	restoreCheckpoint(input: unknown): boolean {
		const validString = (value: unknown): value is string => typeof value === 'string';
		const validSnapshot = validDraftSnapshot;
		const validTimeline = (value: unknown): value is DraftTimeline => record(value) && validSnapshot(value.current) &&
			Array.isArray(value.past) && value.past.every(validSnapshot) && Array.isArray(value.future) && value.future.every(validSnapshot);
		const validContext = (value: unknown): value is ContextSource[] => Array.isArray(value) && value.every(item => record(item) &&
			typeof item.id === 'string' && typeof item.label === 'string' && categories.includes(String(item.category)) &&
			(['connectors', 'mcp'].includes(String(item.category)) || typeof item.content === 'string') &&
			(!('content' in item) || typeof item.content === 'string'));
		let checkpoint: ReviewCheckpoint;
		if (input === null) {
			checkpoint = { schemaVersion: 1, initial: { text: '', approvals: [], choices: [], repeatedWords: [], inTextReview: false, reviewed: false },
				current: { current: { text: '', approvals: [], choices: [], repeatedWords: [], inTextReview: false, reviewed: false }, past: [], future: [] },
				activeBranch: 0, branches: [], contextSources: [], interrupted: false };
		} else {
			if (!record(input) || (input.tags !== undefined && !validTags(input.tags)) || input.schemaVersion !== 1 || !validSnapshot(input.initial) || !validTimeline(input.current) ||
				!index(input.activeBranch) || !Array.isArray(input.branches) || !validContext(input.contextSources) ||
				(input.input !== undefined && !validString(input.input)) || (input.copyKey !== undefined && !validString(input.copyKey)) || typeof input.interrupted !== 'boolean' ||
				!input.branches.every(branch => record(branch) && index(branch.id) && branch.id !== input.activeBranch && (branch.tags === undefined || validTags(branch.tags)) && validTimeline(branch.timeline) && validString(branch.title) &&
					(branch.copyKey === undefined || validString(branch.copyKey)) && (branch.input === undefined || validString(branch.input)) &&
					(branch.contextSources === undefined || validContext(branch.contextSources)))) return false;
			if (new Set(input.branches.map((branch: any) => branch.id)).size !== input.branches.length ||
				input.branches.some((branch: any) => branch.proposal !== undefined && !record(branch.proposal)) ||
				(input.proposal !== undefined && !record(input.proposal))) return false;
			try { checkpoint = structuredClone(input) as unknown as ReviewCheckpoint; } catch { return false; }
		}
		const restoredClarifications = new Map<number, StepThreeState>();
		if (checkpoint.clarifications !== undefined) {
			if (!Array.isArray(checkpoint.clarifications)) return false;
			const branches = new Set([checkpoint.activeBranch, ...checkpoint.branches.map(branch => branch.id)]);
			for (const entry of checkpoint.clarifications) {
				if (!record(entry) || !index(entry.branch) || !branches.has(entry.branch) || restoredClarifications.has(entry.branch)) return false;
				const history = restoreClarification(entry.history);
				if (!history) return false;
				restoredClarifications.set(entry.branch, {history, status: history.terminal ? 'blocked' : 'resume',
					severity: history.terminal ? 'critical' : 'low', total: history.path.length});
			}
		}
		const restoredProposals = new Map<number, RestoredProposal>();
		if (input !== null) {
			try {
				const activeProposal = (checkpoint as ReviewCheckpoint & {proposal?: ProposalCheckpoint}).proposal;
				if (activeProposal) {
					const proposal = this.buildRestoredProposal(activeProposal, checkpoint.current.current.text, checkpoint.current.current.text);
					if (!proposal && !restoredClarifications.has(checkpoint.activeBranch)) return false;
					if (proposal) restoredProposals.set(checkpoint.activeBranch, proposal);
				}
				for (const branch of (checkpoint as ReviewCheckpoint & {branches: readonly (ReviewCheckpoint['branches'][number] & {proposal?: ProposalCheckpoint})[]}).branches) {
					if (!branch.proposal) continue;
					const proposal = this.buildRestoredProposal(branch.proposal, branch.timeline.current.text, branch.timeline.current.text);
					if (!proposal && !restoredClarifications.has(branch.id)) return false;
					if (proposal) restoredProposals.set(branch.id, proposal);
				}
			} catch { return false; }
		}
		this.cancel();
		clearTimeout(this.refreshTimer); this.refreshTimer = undefined;
		this.clearLint(); this.clearMapping(); this.rewriteCheck = undefined;
		this.branches.clear(); this.traceIds.clear(); this.sourcesByBranch.clear();
		this.clarifications.clear();
		this.pickedFiles.clear();
		for (const [branch, state] of restoredClarifications) this.clarifications.set(branch, state);
		this.draft.reset(checkpoint.initial);
		this.draft.resume(checkpoint.current, !checkpoint.interrupted || restoredProposals.has(checkpoint.activeBranch));
		this.tags = checkpoint.tags;
		this.activeBranch = checkpoint.activeBranch; this.nextBranch = this.activeBranch;
		this.restoredClarification = this.clarifications.has(this.activeBranch);
		this.input = checkpoint.input; this.activeCopyKey = (checkpoint as ReviewCheckpoint & {copyKey?: string}).copyKey;
		if (checkpoint.contextSources.length) this.sourcesByBranch.set(this.activeBranch, checkpoint.contextSources);
		for (const branch of checkpoint.branches) {
			if (branch.id === this.activeBranch) continue;
			if (branch.contextSources?.length) this.sourcesByBranch.set(branch.id, branch.contextSources);
			const restoredStage = restoredProposals.get(branch.id) ?? {phase: 'ready' as const};
			this.branches.set(branch.id, { tags: branch.tags, timeline: branch.timeline, stage: restoredStage, title: branch.title,
				copyKey: branch.copyKey, input: branch.input,
				proposalBase: 'rewrite' in restoredStage ? this.rewriteBases.get(restoredStage.rewrite.result) : undefined });
			this.nextBranch = Math.max(this.nextBranch, branch.id);
		}
		this.stage = {phase: 'ready'}; this.batch = undefined; this.entryStatus = undefined; this.lastPreview = undefined;
		const restoredProposal = restoredProposals.get(this.activeBranch);
		this.stage = restoredProposal ?? {phase: 'ready'};
		if (this.stage.phase === 'proposal' || this.stage.phase === 'confirmed') {
			Object.assign(this.stage.rewrite, {revision: this.draft.revision, id: this.version + 1});
		}
		this.commit(checkpoint.interrupted ? 'Previous review work was interrupted. Review it again to continue.' : undefined);
		return true;
	}

	get snapshot() {
		const { stage, draft } = this;
		const base = 'base' in stage ? stage.base : stage;
		const clarification = this.visibleClarification;
		const step = clarification?.history.path[clarification.history.position];
		return structuredClone({
			...(this.tags && {tags: this.tags}), version: this.version, revision: draft.revision, text: draft.text, state: draft.state, stepIds: this.stepIds,
			canNext: this.canNext(), entryStatus: this.entryStatus, input: this.submittedInput, batch: this.batch && { ...this.batch, expanded: draft.inTextReview },
			phase: this.batch ? (stage.phase === 'ready' ? 'text-review' as const : stage.phase) :
				'rewrite' in stage ? stage.phase : draft.state === 'editor' ? 'draft' as const : draft.state === 'review' ? 'review' as const : stage.phase,
			flags: draft.flags, approvals: draft.approvals, history: { ...draft.history, activeBranch: this.activeBranch, activeCopyKey: this.activeCopyKey,
				branches: Array.from(this.branches, ([id, {title, copyKey, stage}]) => ({ id, title, copyKey,
					proposalId: 'rewrite' in stage ? stage.rewrite.id : undefined })).reverse() }, notice: this.notice,
			harper: base.phase === 'harper-reviewed' ? base.harper : undefined,
			rewriteOutcome: 'rewriteOutcome' in base ? base.rewriteOutcome : undefined,
			rewrite: 'rewrite' in stage ? stage.rewrite as Proposal & { confirmed?: string } : stage.phase === 'rewriting' ? stage.previous?.rewrite as (Proposal & {confirmed?: string}) | undefined : undefined,
			mapping: this.mapping?.result, mappingId: this.mapping?.id,
			...(this.services.stepThree && { clarificationEnabled: true }),
			...(clarification && { clarification: {
				session: clarification.history.id, questionIds: clarification.history.path.map(item => item.question.id),
				status: clarification.status, wording: clarification.history.wording, total: clarification.total, severity: clarification.severity,
				position: clarification.history.position, reached: clarification.history.path.length, question: step?.question,
				response: step?.response && (step.response.kind === 'skipped' ? {skip: true} : {input: answerInput(step.response.value), value: step.response.value}),
				mapping: clarification.mapping, decisions: activeDecisions(clarification.history),
				message: clarification.message, alert: clarification.alert,
			}}),
			workerInput: this.readWorkerInput(this.version),
		});
	}

	readWorkerInput(version: number): WorkerInput | undefined {
		if (version !== this.version || this.stage.phase !== 'confirmed') return;
		const { id, revision, text, confirmed, source, result } = this.stage.rewrite;
		const kind = this.stage.rewrite.restoredConfirmationKind ?? (confirmed === text ? 'source' : confirmed === result.text ? 'proposal' : 'edited');
		// A human's revised wording is an explicit whole-text replacement, not the model's edit plan.
		const changes = kind === 'source' ? [] : kind === 'proposal' ? result.changes :
			[{ rangeOffset: 0, rangeLength: text.length, text: confirmed }];
		const provenance = kind === 'proposal' ? result.provenance :
			[{ output: { start: 0, end: confirmed.length }, source: kind === 'source' ? { start: 0, end: text.length } : null }];
		const saved = this.sessionMappings.get(result);
		return structuredClone({ ...(this.tags && {tags: this.tags}), version, revision, proposalId: id, sourceText: text, wording: confirmed,
			...(saved?.wording === confirmed && saved.result.editVersion > 0 && {mapping: saved.result.frame}),
			approval: { kind, jobId: result.jobId, source: sourceRef(source) }, changes, provenance, editResult: result });
	}

	subscribe(listener: () => void): () => void {
		const subscription = () => listener();
		this.listeners.add(subscription);
		return () => {
			if (this.listeners.delete(subscription) && !this.listeners.size) this.cancel();
		};
	}

	private commit(notice?: string): CommandResult {
		if (this.mapping && (this.stage.phase !== 'proposal' || this.stage.rewrite !== this.mapping.proposal)) this.clearMapping();
		if (this.rewriteCheck && (this.stage.phase !== 'proposal' || this.stage.rewrite.id !== this.rewriteCheck.proposalId)) {
			this.rewriteCheck = undefined;
			this.clearLint();
		}
		this.notice = notice;
		this.version++;
		for (const listener of [...this.listeners]) {
			try { listener(); }
			catch { console.error('A review subscriber failed to process the update.'); }
		}
		return accepted;
	}

	private clearMapping() {
		this.mapping?.controller.abort();
		this.mapping = undefined;
	}

	private cancelClarification() {
		if (!this.assessment) return;
		const { branch, controller } = this.assessment;
		this.assessment = undefined;
		controller.abort();
		const state = this.clarifications.get(branch);
		if (state?.status === 'checking') state.status = 'resume';
	}

	private beginClarification(wording: string, seed?: readonly {prompt: string; quotes: string[]}[]) {
		let state = this.stepThree;
		if (!this.services.stepThree || (state?.history.terminal && state.history.wording === wording)) return false;
		if (state?.history.wording === wording && state.status !== 'resume' && state.status !== 'failed') return false;
		const resuming = state?.history.wording === wording;
		if (!state || !resuming) {
			const history = newHistory(wording);
			if (state) history.orphaned = [...state.history.orphaned, ...(state.history.path.length
				? [{steps: state.history.path, at: new Date().toISOString()}] : [])];
			state = { history, status: 'resume', total: 0, severity: 'low' };
			this.clarifications.set(this.activeBranch, state);
		}
		this.assessClarification(state, resuming, seed);
		return true;
	}

	private assessClarification(state: StepThreeState, preservePosition = false, seed?: readonly {prompt: string; quotes: string[]}[]) {
		const services = this.services.stepThree;
		if (!services) return blocked;
		this.cancelClarification();
		const job = {branch: this.activeBranch, controller: new AbortController()};
		const {signal} = job.controller;
		const history = structuredClone(state.history);
		const position = history.position;
		this.assessment = job;
		state.status = 'checking'; state.mapping = undefined; state.message = undefined;
		this.commit();
		this.assessmentTail = this.assessmentTail.then(async () => {
			try {
				signal.throwIfAborted();
				const assessment = await assessStepThree(history, services, stepId(), signal, seed);
				if (this.assessment !== job || this.stepThree !== state) return;
				if (preservePosition && position < history.path.length) history.position = position;
				Object.assign(state, {mapping: undefined, message: undefined, ...assessment, history});
			} catch (error) {
				if (this.assessment !== job) return;
				state.status = 'failed';
				state.message = error instanceof Error ? error.message : 'The clarification check could not finish.';
			}
			if (this.assessment === job) { this.assessment = undefined; this.commit(); }
		});
		return accepted;
	}

	private questionKey(id: string) { return `${this.activeBranch}:${id}`; }

	clarificationResource(version: unknown, id: unknown, field?: unknown) {
		const state = this.visibleClarification;
		const question = state?.history.path[state.history.position]?.question;
		if (!question || version !== this.version || typeof id !== 'string' || id !== question.id ||
			state?.status === 'checking' || state?.status === 'blocked') return;
		const control = question.control.kind === 'fields' ? question.control.fields.find(item => item.id === field)?.field : question.control;
		return { reference: question.reference as Reference | undefined, file: control?.kind === 'file' ? control : undefined };
	}

	registerClarificationFiles(version: unknown, id: unknown, field: unknown, files: FileAnswer[]): boolean {
		if (!this.clarificationResource(version, id, field)?.file || typeof id !== 'string') return false;
		const key = this.questionKey(id);
		const previous = this.pickedFiles.get(key) ?? [];
		this.pickedFiles.set(key, [...previous.filter(file => !files.some(entry => entry.uri === file.uri)), ...files]);
		return true;
	}

	async clarificationReference(version: unknown, id: unknown): Promise<Reference | undefined> {
		const reference = this.clarificationResource(version, id)?.reference;
		const state = this.visibleClarification;
		if (!reference || !state || !this.services.stepThree?.context) return reference;
		const controller = new AbortController();
		const evidence = await this.services.stepThree.context(assessmentWording(state.history).wording, controller.signal);
		if (this.visibleClarification !== state || !this.clarificationResource(version, id)?.reference) return;
		if (!evidence.references.some(item => item.label === reference.label && item.excerpt === reference.excerpt)) {
			throw new Error('This reference changed. Check the approved source again.');
		}
		return reference;
	}

	private async runMapping(check: MappingCheck, wording: string) {
		try {
			const frame = await (this.services.mapPrompt ?? mapPrompt)(wording, check.controller.signal, check.id);
			if (this.mapping !== check) return;
			check.result = {status: mappingStatus(frame), frame, parsed: frame, editVersion: 0};
			this.sessionMappings.set(check.proposal.result, {wording, result:check.result});
		} catch (error) {
			if (this.mapping !== check) return;
			check.result = {status: 'failed', message: error instanceof Error ? error.message :
				'The mapping check did not return a valid frame. Try again or revise the wording.'};
		}
		this.commit();
	}

	private clearLint(): void {
		this.lint?.controller.abort();
		this.lint = undefined;
	}

	private check(draft: HarperHandoff): Promise<HarperReview> {
		if (this.lint?.revision === draft.revision && this.lint.text === draft.text) return this.lint.result;
		this.clearLint();
		const controller = new AbortController();
		// WASM lint can finish after cancellation. Serialize across revisions and skip obsolete queued work.
		const result = this.lintTail.then(async () => {
			controller.signal.throwIfAborted();
			// A failed WASM setup or a hung adapter must eventually release the queue for a retry.
			let timer: NodeJS.Timeout | undefined;
			const deadline = new Promise<never>((_, reject) => {
				timer = setTimeout(() => {
					controller.abort();
					reject(new Error('Harper timed out'));
				}, 30_000);
			});
			try {
				const review = await Promise.race([this.services.harper(draft, controller.signal), deadline]);
				controller.signal.throwIfAborted();
				if (!validHarper(draft, review)) throw new Error('Invalid Harper result');
				return review;
			} finally {
				clearTimeout(timer);
			}
		});
		this.lint = { revision: draft.revision, text: draft.text, controller, result };
		this.lintTail = result.then(() => {}, () => {
			if (this.lint?.controller === controller) this.lint = undefined; // Explicit retry gets a new check.
		});
		return result;
	}

	private canNext(): boolean {
		if (!this.batch) return this.entryStatus === 'allowed';
		if (this.batch.status !== 'ready' || this.batch.issues.some(issue => issue.replacement === undefined)) return false;
		return Boolean(projectText(this.draft.text, this.batch.issues).text.trim());
	}

	private checkText(mode: 'entry' | 'submit' | 'review' = 'review', delay = 0): CommandResult {
		if (mode !== 'entry' && this.stage.phase !== 'ready') {
			this.stopEffect();
			this.stage = { phase: 'ready' };
		}
		clearTimeout(this.refreshTimer);
		const entry = mode === 'entry';
		this.entryStatus = entry ? 'checking' : undefined;
		this.batch = entry ? undefined : { status: 'checking', issues: [] };
		const draft = { text: this.draft.text, revision: this.draft.revision };
		const timer = this.refreshTimer = setTimeout(async () => {
			try {
				const step = entry ? 1 : 2;
				const flags = this.draft.previewFlags(run => this.capture?.(this.stepIds[step - 1], step, draft.revision, entry ? 'Input' : 'Review', run));
				const { findings } = await this.check(draft);
				if (this.refreshTimer !== timer) return;
				const plausible = hasPlausibleWording(draft.text, flags, this.draft.withoutValidated(findings));
				if (entry) {
					this.entryStatus = plausible ? 'allowed' : 'noise';
				} else if (plausible) {
					const issues = this.reviewIssues(findings, flags);
					if (!issues.length && !this.draft.inTextReview && this.input === undefined) {
						this.batch = undefined;
						this.draft.submit();
					} else {
						this.draft.inTextReview = true;
						this.batch = { status: 'ready', issues };
						if (mode === 'submit' && !issues.length && this.stage.phase === 'ready') {
							this.startRewrite(this.stage, draft, [], true);
							return;
						}
					}
				} else {
					this.batch = { status: 'needs-text', issues: [] };
				}
				this.commit(plausible ? undefined : 'Add a few words describing what you want to do.');
			} catch {
				if (this.refreshTimer !== timer) return;
				if (entry) this.entryStatus = 'failed';
				else this.batch = { status: 'failed', issues: [] };
				this.commit('The text check could not finish.');
			}
		}, delay);
		return this.commit();
	}

	private reviewIssues(findings: HarperReview['findings'], initialFlags: ReturnType<RequestReview['previewFlags']>) {
		const { draft } = this;
		const remaining = draft.withoutValidated(findings);
		const flags = [...new Map([...initialFlags, ...draft.replacementFlags()].map(flag => [flag.start, flag])).values()];
		// A changed neighbour can put an untouched word inside a new Markov window.
		// Each pass can only add previously unseen raw words.
		const known = new Set(flags.map(flag => flag.start));
		const suppressed = new Set<number>();
		while (true) {
			const issues = textIssues(draft.text, flags, remaining, draft.choices);
			for (const issue of issues) {
				if (suppressed.has(issue.start)) issue.replacement = undefined;
			}
			const output = projectText(draft.text, issues);
			if (!output.changes.length) return issues;
			const count = flags.length + suppressed.size;
			for (const flag of draft.projectedFlags(output.text, output.changes, run => this.capture?.(this.stepIds[1], 2, draft.revision, 'Projection', run))) {
				const original = originalSpan(flag, output.changes);
				if (original && !known.has(original.start)) {
					flags.push({ ...flag, ...original });
					known.add(original.start);
				}
				if (!original) {
					let shift = 0;
					for (const change of output.changes) {
						const start = change.rangeOffset + shift;
						const end = start + change.text.length;
						if (flag.start < end && flag.end > start) suppressed.add(change.rangeOffset);
						shift += change.text.length - change.rangeLength;
					}
				}
			}
			if (flags.length + suppressed.size === count) return issues;
		}
	}

	private finishText(): CommandResult {
		const { text, changes } = projectText(this.draft.text, this.batch!.issues);
		this.batch = undefined;
		this.draft.finalize(text, changes);
		if (this.draft.state === 'review') {
			this.draft.inTextReview = true;
			return this.checkText();
		}
		return this.draftChanged();
	}

	isDraftVersion(version: unknown, revision: unknown): boolean {
		return !this.batch && version === this.version && revision === this.draft.revision && this.draft.state === 'editor' && meetsDraftMinimums(this.draft.text);
	}

	async preview() {
		const { draft } = this;
		const stamp = { version: this.version, revision: draft.revision };
		if (!this.isDraftVersion(stamp.version, stamp.revision)) return { ...stamp, groups: [], harperUnavailable: false };
		const flags = draft.previewFlags();
		let review: HarperReview | undefined;
		try { review = await this.check({ revision: draft.revision, text: draft.text }); }
		catch { /* Markov remains available when advisory lint fails. */ }
		const groups = combinePreview(flags, draft.withoutValidated(review?.findings ?? []));
		if (this.isDraftVersion(stamp.version, stamp.revision)) this.lastPreview = { version: stamp.version, groups };
		return { ...stamp, groups, harperUnavailable: !review };
	}

	async replacementCandidates(version: unknown, revision: unknown, start: unknown) {
		const { draft } = this;
		if (version !== this.version || revision !== draft.revision || draft.state !== 'review') return;
		const flag = draft.flags.find(word => word.start === start);
		if (!flag) return;
		try {
			const review = await this.check({ revision: draft.revision, text: draft.text });
			const advice = review.findings.filter(item => item.start >= flag.start && item.end <= flag.end);
			return { version, revision, start, advice, unavailable: false };
		} catch {
			return { version, revision, start, advice: [], unavailable: true };
		}
	}

	private checked(review: HarperReview): Checked {
		const findings = this.draft.withoutValidated(review.findings);
		return { ...review, findings, groups: combinePreview([], findings) };
	}

	private stopEffect(): void {
		if ('controller' in this.stage) this.stage.controller.abort();
		if (this.stage.phase === 'checking-harper') this.clearLint();
	}

	cancel(): void {
		if (this.assessment) { this.cancelClarification(); this.commit(); }
		if (this.rewriteCheck && this.stage.phase === 'proposal') {
			this.rewriteCheck = undefined;
			this.stage = { ...this.stage, rewrite: { ...this.stage.rewrite, review: { ...this.stage.rewrite.review, status: 'failed' } } };
			this.clearLint();
			this.commit('The wording check was interrupted.');
		}
		if (this.mapping?.result.status === 'checking') {
			this.clearMapping();
			this.commit();
		}
		clearTimeout(this.refreshTimer);
		this.refreshTimer = undefined;
		this.clearLint();
		if (this.entryStatus === 'checking') {
			this.entryStatus = 'failed';
			this.commit('The text check was interrupted.');
			return;
		}
		if (this.batch?.status === 'checking') {
			this.batch = { status: 'failed', issues: [] };
			this.commit('The text check was interrupted.');
			return;
		}
		if (this.stage.phase !== 'rewriting' && this.stage.phase !== 'checking-harper') return;
		if (this.stage.phase === 'rewriting') this.stage.controller.abort();
		this.stage = this.stage.phase === 'rewriting' ? this.stage.previous ?? this.stage.base : { phase: 'ready' };
		this.commit('Cancelled.');
	}

	private park(timeline = this.draft.timeline(), stage = this.stage, batch: ReviewBatch | null | undefined = this.batch): void {
		const resting = stage.phase === 'rewriting' ? stage.previous ?? stage.base : stage.phase === 'checking-harper' ? { phase: 'ready' as const } : stage;
		const tip = timeline.future[0] ?? timeline.current;
		const title = resting.phase === 'confirmed' ? resting.rewrite.confirmed :
			projectText(tip.text, [...tip.choices].sort((a, b) => a.start - b.start)).text;
		this.branches.set(this.activeBranch, { tags: this.tags, timeline, stage: resting, title, copyKey: this.activeCopyKey, input: this.input, batch: batch ?? undefined,
			proposalBase: 'rewrite' in resting ? this.rewriteBases.get(resting.rewrite.result) : undefined });
	}

	private openBranch(id: number, branch: SavedBranch): CommandResult {
		this.cancelClarification();
		this.park();
		this.branches.delete(id);
		this.activeBranch = id;
		this.tags = branch.tags;
		this.restoredClarification = this.clarifications.has(id);
		this.activeCopyKey = branch.copyKey;
		this.stopEffect();
		this.clearLint();
		clearTimeout(this.refreshTimer);
		this.refreshTimer = undefined;
		this.lastPreview = undefined;
		this.batch = undefined;
		this.entryStatus = undefined;
		this.draft.resume(branch.timeline);
		this.input = branch.input;
		this.batch = branch.batch;
		const revision = this.draft.revision;
		const stage = branch.stage;
		const base = 'base' in stage ? stage.base : stage;
		const ready: Ready = base.phase === 'harper-reviewed' ? { phase: base.phase, harper: { ...base.harper, revision } } : base;
		this.stage = 'rewrite' in stage ? { ...stage, base: ready, rewrite: { ...stage.rewrite, revision } } as Stage : ready;
		if ('rewrite' in this.stage && branch.proposalBase) this.rewriteBases.set(this.stage.rewrite.result, branch.proposalBase);
		if (this.stage.phase === 'proposal' && this.stage.rewrite.review.status === 'checking') return this.checkWording(this.stage.rewrite.review.wording);
		if (this.batch?.status === 'ready' || this.restoredClarification) return this.commit();
		return this.stage.phase === 'ready' ? this.draftChanged() : this.commit();
	}

	createInputPreview(base: string): ReviewWorkflow {
		const preview = new ReviewWorkflow(this.services, this.capture);
		preview.draft.edit(base);
		return preview;
	}

	archiveAndReview(preview: ReviewWorkflow, text: string, key: string, version: number, revision: number): CommandResult {
		if (typeof key !== 'string' || key.length === 0 || key.length > 64) return invalid;
		if (version !== this.version || revision !== this.draft.revision) return { status: 'stale' };
		if (this.submittedInput === undefined || text === this.submittedInput || preview.draft.text !== text || preview.entryStatus !== 'allowed') return blocked;
		this.cancelClarification();
		this.park();
		this.activeBranch = ++this.nextBranch;
		this.restoredClarification = false;
		this.activeCopyKey = key;
		this.traceIds.set(this.activeBranch, [...preview.stepIds]);
		this.stopEffect();
		this.clearLint();
		this.stage = { phase: 'ready' };
		this.lastPreview = undefined;
		this.draft.resume(preview.draft.timeline());
		this.input = text;
		// The preview ran the entry gate on this exact wording. Reuse its checked Harper findings.
		if (preview.lint) {
			const revision = this.draft.revision;
			this.lint = { revision, text, controller: new AbortController(), result: preview.lint.result.then(result => ({ ...result, revision })) };
		}
		return this.checkText('submit');
	}

	private draftChanged(notice?: string): CommandResult {
		this.cancelClarification();
		this.restoredClarification = false;
		this.stopEffect();
		if (this.lint && this.lint.revision !== this.draft.revision) this.clearLint();
		this.stage = { phase: 'ready' };
		clearTimeout(this.refreshTimer);
		this.refreshTimer = undefined;
		this.entryStatus = undefined;
		this.batch = undefined;
		if (!this.draft.inTextReview) this.input = undefined;
		if (this.draft.state !== 'ready' || this.draft.inTextReview) {
			if (meetsDraftMinimums(this.draft.text)) return this.checkText(this.draft.inTextReview ? 'review' : 'entry', 200);
			if (this.draft.inTextReview) {
				this.batch = { status: 'needs-text', issues: [] };
				return this.commit('Use at least five words and 15 characters.');
			}
		}
		return this.commit(notice);
	}

	private async runEffect(job: ActiveJob, draft: HarperHandoff, useReviewed = false) {
		try {
			if (job.phase === 'checking-harper') {
				const review = await this.check(draft);
				if (this.stage !== job) return;
				this.stage = { phase: 'harper-reviewed', harper: this.checked(review) };
			} else {
				const response = useReviewed ? {schemaVersion: 1, jobId: job.request.jobId, source: sourceRef(job.request.source), kind: 'unchanged'} :
					await this.services.rewrite(job.request, job.controller.signal);
				if (this.stage !== job) return; // A late result cannot complete a retry at the same revision.
				job.controller.signal.throwIfAborted();
				const applied = applyEditResult(job.request, response);
				if (!applied.ok) throw new QwenRewriteError(`The model edit result was rejected (${applied.error.code}). Try again.`);
				let result = applied.value;
				let questions: { prompt: string; quotes: string[] }[] | undefined;
				if (result.kind === 'needs-context' && this.services.stepThree) {
					const source = job.request.source;
					const offsets = new Map(source.boundaries.map(point => [point.id, point.offset]));
					questions = result.questions.map(question => ({prompt: question.question,
						quotes: question.evidence.map(range => source.text.slice(offsets.get(range.start)!, offsets.get(range.end)!))}));
					const unchanged = applyEditResult(job.request, {schemaVersion: 1, jobId: job.request.jobId, source: sourceRef(source), kind: 'unchanged'});
					if (unchanged.ok) result = unchanged.value;
				}
				if (result.kind !== 'proposal' && result.kind !== 'unchanged') {
					this.stage = job.previous ?? { ...job.base, rewriteOutcome: { source: job.request.source, result } };
					this.commit(result.kind === 'needs-context' ? result.questions.map(item => item.question).join(' ') : result.message);
					return;
				}
				if (!result.text.trim()) throw new QwenRewriteError('The model edits left no request to review. Try again.');
				this.rewriteBases.set(result, job.reviewBase);
				this.stage = { phase: 'proposal', base: job.base, rewrite: { ...draft, id: this.version + 1,
					proposed: result.text, source: job.request.source, result,
					...(job.previous && {previousWordings: [...new Set([...(job.previous.rewrite.previousWordings ?? []), job.previous.rewrite.proposed, draft.text])]}),
					review: { wording: result.text, status: 'checking', groups: [] } } };
				this.checkWording(result.text, questions);
				return;
			}
			this.commit();
		} catch (error) {
			if (this.stage !== job) return;
			this.stage = job.phase === 'rewriting' ? job.previous ?? job.base : { phase: 'ready' };
			this.commit(job.phase === 'checking-harper' ? 'Harper could not check the request. Try again.' :
				error instanceof Error ? error.message : 'The local model could not finish the rewrite. Try again.');
		}
	}

	/** Check an isolated candidate using exact edits, without mutating the user's draft or approving it. */
	private checkWording(wording: string, seed?: readonly {prompt: string; quotes: string[]}[]): CommandResult {
		if (this.stage.phase !== 'proposal') return blocked;
		this.cancelClarification();
		const proposal = this.stage.rewrite;
		const candidate = new RequestReview('');
		candidate.resume(this.rewriteBases.get(proposal.result)!);
		candidate.edit(wording, wording === proposal.result.text ? proposal.result.changes :
			[{ rangeOffset: 0, rangeLength: proposal.text.length, text: wording }]);
		const flags = candidate.previewFlags();
		const check = { id: stepId(), proposalId: proposal.id };
		this.rewriteCheck = check;
		this.stage = { ...this.stage, rewrite: { ...proposal, review: { wording, status: 'checking', groups: combinePreview(flags, []) } } };
		this.commit('Checking wording…');
		if (this.rewriteCheck === check) void (async () => {
			try {
				const review = await this.check({ text: wording, revision: proposal.revision });
				if (this.rewriteCheck !== check || this.stage.phase !== 'proposal') return;
				const groups = combinePreview(flags, candidate.withoutValidated(review.findings));
				this.stage = { ...this.stage, rewrite: { ...this.stage.rewrite, review: { wording, status: 'ready', groups } } };
				this.rewriteCheck = undefined;
				const flagged = groups.map(group => JSON.stringify(wording.slice(group.start, group.end))).join(', ');
				if (groups.length || !this.beginClarification(wording, seed)) this.commit(groups.length ? `Check the flagged wording: ${flagged}.` : undefined);
			} catch {
				if (this.rewriteCheck !== check || this.stage.phase !== 'proposal') return;
				this.stage = { ...this.stage, rewrite: { ...this.stage.rewrite, review: { wording, status: 'failed', groups: combinePreview(flags, []) } } };
				this.rewriteCheck = undefined;
				this.commit('The wording check could not finish.');
			}
		})();
		return accepted;
	}

	private startRewrite(base: Ready, handoff: HarperHandoff, changes: readonly TextChange[] = [], useReviewed = false, previous?: ProposedStage): CommandResult {
		this.cancelClarification();
		const candidate = new RequestReview('');
		candidate.resume({ current: this.draft.timeline().current, past: [], future: [] });
		candidate.edit(handoff.text, changes);
		const request = createRewriteRequest(handoff, `${this.sourceId}:${this.activeBranch}`, stepId());
		return this.startEffect({ phase: 'rewriting', base: { ...base, rewriteOutcome: undefined },
			previous, controller: new AbortController(), request, reviewBase: { current: candidate.timeline().current, past: [], future: [] } }, handoff, useReviewed);
	}

	dispatch(message: unknown): CommandResult {
		if (!record(message) || typeof message.type !== 'string') return invalid;
		if (message.type === 'sync') return accepted;
		if (!index(message.version) || !index(message.revision)) return invalid;
		const { draft, stage } = this;
		if (message.type === 'set-draft-tags') {
			const tags = message.tags;
			if (!validTags(tags) || !validTags(message.previous)) return invalid;
			// A background text check can advance the version without changing either tag.
			if (message.stepId !== this.stepIds[0] || message.revision !== draft.revision ||
				message.previous.task !== this.tags?.task || message.previous.criticality !== this.tags?.criticality) {
				return {status: 'stale', notice: 'The draft changed. Select the tag again.'};
			}
			if (!tags.task && tags.criticality && tags.criticality !== this.tags?.criticality) return blocked;
			this.tags = tags.task || tags.criticality ? {
				...(tags.task && {task: tags.task}), ...(tags.criticality && {criticality: tags.criticality}),
			} : undefined;
			return this.commit(this.notice);
		}
		// Text revision guards offsets. Version also guards approvals, history, proposals and job ownership.
		if (message.version !== this.version || message.revision !== draft.revision) {
			return { status: 'stale', notice: 'The review changed. Use the current version.' };
		}
		const clarification = this.visibleClarification;
		const step = clarification?.history.path[clarification.history.position];
		switch (message.type) {
			case 'resume-clarification':
				if (clarification?.status === 'resume' || clarification?.status === 'failed') return this.assessClarification(clarification, true);
				if (!clarification && stage.phase === 'proposal' && stage.rewrite.review.status === 'ready' && !stage.rewrite.review.groups.length) {
					return this.beginClarification(stage.rewrite.review.wording) ? accepted : blocked;
				}
				return blocked;
			case 'review-step-three-wording':
				if (!this.services.stepThree || clarification?.history.terminal || stage.phase !== 'proposal' ||
					stage.rewrite.id !== message.proposalId || typeof message.wording !== 'string' || !message.wording.trim()) return blocked;
				return this.checkWording(message.wording);
			case 'navigate-clarification':
				if (!clarification || !step || step.question.id !== message.questionId || !index(message.position) ||
					message.position >= clarification.history.path.length || !['ready','questions'].includes(clarification.status)) return blocked;
				clarification.history.position = message.position;
				clarification.alert = undefined;
				return this.commit();
			case 'submit-clarification': {
				if (!clarification || !step || step.question.id !== message.questionId || !['ready','questions'].includes(clarification.status) ||
					(message.skip !== undefined && message.skip !== true)) return blocked;
				let response: Response = {kind: 'skipped'};
				const later = clarification.history.path.slice(clarification.history.position + 1);
				clarification.alert = undefined;
				if (!message.skip) {
					const last = step.response?.kind === 'answered' ? step.response.value : undefined;
					const savedFiles = Array.isArray(last) ? last : last && typeof last === 'object' && 'fields' in last
						? Object.values(last.fields).flatMap(value => Array.isArray(value) ? value : []) : [];
					const files = [...(this.pickedFiles.get(this.questionKey(step.question.id)) ?? []), ...savedFiles];
					const result = validateAnswer(step.question.control, message.input, files);
					if (!result.ok) return {status: 'invalid', notice: result.error};
					clarification.alert = result.alert;
					response = {kind: 'answered', value: result.value};
				}
				if (!commitAnswer(clarification.history, response)) {
					if (clarification.history.position + 1 < clarification.history.path.length) clarification.history.position++;
					return this.commit();
				}
				for (const item of later) this.pickedFiles.delete(this.questionKey(item.question.id));
				this.clearMapping();
				return this.assessClarification(clarification);
			}
			case 'save-step-three-mapping': {
				const mapping = clarification?.mapping;
				if (!clarification || !mapping || mapping.frame.id !== message.frameId || mapping.editVersion !== message.editVersion) return blocked;
				try {
					clarification.mapping = saveStepThreeMapping(mapping, message.fields);
					clarification.history.mappingEdits = {wording: mapping.wording, fields: clarification.mapping.frame.reviewFields!};
					return this.commit();
				} catch (error) { return {status: 'invalid', notice: error instanceof Error ? error.message : 'Invalid mapping.'}; }
			}
		}
		if (message.type === 'open-branch' || message.type === 'discard-branch') {
			if (!index(message.id)) return invalid;
			const branch = this.branches.get(message.id);
			if (!branch) return blocked;
			if (message.type === 'open-branch') return this.openBranch(message.id, branch);
			this.branches.delete(message.id);
			this.traceIds.delete(message.id);
			this.sourcesByBranch.delete(message.id);
			this.clarifications.delete(message.id);
			for (const key of this.pickedFiles.keys()) if (key.startsWith(`${message.id}:`)) this.pickedFiles.delete(key);
			return this.commit(this.notice);
		}
		if (message.type === 'open-copy') {
			if (typeof message.text !== 'string' || typeof message.base !== 'string' ||
				typeof message.key !== 'string' || !message.key.length || message.key.length > 64) return invalid;
			if (this.activeCopyKey === message.key) return accepted;
			for (const [id, branch] of this.branches) {
				if (branch.copyKey === message.key) return this.openBranch(id, branch);
			}
			const copy = new RequestReview('');
			copy.edit(message.base);
			copy.edit(message.text);
			return this.openBranch(++this.nextBranch, { tags: this.tags, timeline: copy.timeline(), stage: { phase: 'ready' }, title: message.text, copyKey: message.key });
		}
		if (this.batch && !['edit', 'undo', 'redo', 'drop-action', 'restore', 'revoke', 'validate', 'next', 'choose', 'replacement-clipped', 'retry-text-review',
			'rewrite-reviewed', 'use-reviewed-wording', 'cancel', 'confirm-rewrite', 'keep-draft', 'rewrite-input', 'check-mapping', 'save-mapping', 'answer-question', 'back-from-mapping'].includes(message.type)) return blocked;
		switch (message.type) {
			case 'rewrite-input': {
				if (stage.phase !== 'proposal' || stage.rewrite.id !== message.proposalId || stage.rewrite.review.status === 'checking') return blocked;
				if (typeof message.wording !== 'string' || !message.wording.trim()) return invalid;
				return this.startRewrite(stage.base, {text: message.wording, revision: draft.revision},
					[changedSpan(draft.text, message.wording)], false, stage);
			}
			case 'check-mapping': {
				if (!index(message.proposalId) || typeof message.wording !== 'string' || !message.wording.trim()) return invalid;
				if (stage.phase !== 'proposal' || stage.rewrite.id !== message.proposalId ||
					stage.rewrite.review.status === 'checking' || this.mapping?.result.status === 'checking') return blocked;
				this.clearMapping();
				const proposal = { ...stage.rewrite, checkedWording: message.wording };
				this.stage = { ...stage, rewrite: proposal };
				const check: MappingCheck = {id: stepId(), proposal, controller: new AbortController(), result: {status: 'checking'}};
				const saved = this.sessionMappings.get(proposal.result);
				if (saved?.wording === message.wording) {
					check.id = saved.result.frame.id;
					check.result = saved.result;
				} else this.sessionMappings.delete(proposal.result);
				this.mapping = check;
				this.commit();
				if (this.mapping === check && check.result.status === 'checking') void this.runMapping(check, message.wording);
				return accepted;
			}
			case 'answer-question': {
				const check = this.mapping;
				if (!check || stage.phase !== 'proposal' || stage.rewrite.id !== message.proposalId ||
					check.id !== message.frameId || !('frame' in check.result) || check.result.editVersion !== message.editVersion) return blocked;
				const questions = clarificationQuestions(check.result);
				if (!questions.some(q => q.id === message.questionId) || typeof message.answer !== 'string' || !message.answer.trim()) return invalid;
				const answers = [...(check.result.answers ?? []).filter(a => a.questionId !== message.questionId),
					{questionId: message.questionId as string, text: message.answer.trim()}];
				check.result = {...check.result, answers, editVersion: check.result.editVersion + 1,
					status: questions.every(q => answers.some(a => a.questionId === q.id)) && check.result.frame.actions.length ? 'mapped' : 'needs-revision'};
				this.sessionMappings.set(check.proposal.result, {wording:check.proposal.checkedWording!, result:check.result});
				return this.commit();
			}
			case 'save-mapping': {
				const check = this.mapping;
				if (stage.phase !== 'proposal' || stage.rewrite.id !== message.proposalId || !check || !('frame' in check.result) ||
					check.id !== message.frameId || check.result.editVersion !== message.editVersion) return blocked;
				const wording = check.proposal.checkedWording!;
				try {
					const frame = readPromptMapping(message.frame, wording, check.id, 'developer');
					const questions = clarificationQuestions({frame, parsed:check.result.parsed});
					const answers = check.result.answers?.filter(a => questions.some(q => q.id === a.questionId));
					const resolved = answers?.length && questions.every(q => answers.some(a => a.questionId === q.id));
					check.result = {status: resolved && frame.actions.length ? 'mapped' : mappingStatus(frame), parsed: check.result.parsed, frame, answers, editVersion: check.result.editVersion + 1};
					this.sessionMappings.set(check.proposal.result, {wording, result: check.result});
					return this.commit('Mapping saved for this wording.');
				} catch (error) {
					return {status: 'invalid', notice: error instanceof Error ? error.message : 'Invalid mapping.'};
				}
			}
			case 'back-from-mapping':
				if (stage.phase !== 'proposal' || stage.rewrite.id !== message.proposalId || !this.mapping) return blocked;
				this.clearMapping();
				return this.commit();
			case 'start-review':
				if (this.batch || !this.canNext()) return blocked;
				this.input = draft.text;
				return this.checkText('submit');
			case 'use-reviewed-wording': case 'rewrite-reviewed': {
				if (!this.batch && message.type === 'use-reviewed-wording') {
					if (stage.phase !== 'ready' && stage.phase !== 'harper-reviewed') return blocked;
					const handoff = draft.advance();
					return handoff ? this.startRewrite(stage, handoff, [], true) : blocked;
				}
				if (!this.batch || !this.canNext() || stage.phase !== 'ready') return blocked;
				const { text, changes } = projectText(draft.text, this.batch.issues);
				return this.startRewrite(stage, { text, revision: draft.revision }, changes, message.type === 'use-reviewed-wording');
			}
			case 'next':
				if (!this.canNext()) return blocked;
				return this.batch ? this.finishText() : this.checkText();
			case 'retry-text-review':
				if (this.entryStatus === 'failed') return this.checkText('entry');
				if (this.batch?.status !== 'failed') return blocked;
				return this.checkText(this.input !== undefined && !draft.inTextReview ? 'submit' : 'review');
			case 'replacement-clipped':
				if (!index(message.start) || !index(message.end)) return invalid;
				if (this.stage.phase !== 'ready' || this.batch?.status !== 'ready' ||
					!this.batch.issues.some(issue => issue.start === message.start && issue.end === message.end)) return blocked;
				this.noteReplacement('multiple-words', message.start, message.end);
				return accepted;
			case 'choose': {
				if (!index(message.start) || !index(message.end) || typeof message.replacement !== 'string' ||
					(message.apply !== undefined && typeof message.apply !== 'boolean') ||
					(message.custom !== undefined && typeof message.custom !== 'boolean')) return invalid;
				if (this.batch?.status !== 'ready') return blocked;
				const issue = this.batch.issues.find(item => item.start === message.start && item.end === message.end);
				if (!issue) return blocked;
				const original = draft.text.slice(issue.start, issue.end);
				const replacement = message.custom ? this.parseReplacement(message.replacement, issue.start, issue.end) : message.replacement;
				if (replacement === undefined || (!message.custom && !issue.candidates.includes(replacement)) || replacement === original) return blocked;
				if (replacementCaseMismatch(original, replacement)) this.noteReplacement('casing-mismatch', issue.start, issue.end);
				if (message.apply || message.custom || issue.replacement === undefined) {
					this.replace(issue.start, issue.end, replacement, true);
					return this.draftChanged();
				}
				if (issue.replacement === replacement) return accepted;
				draft.choose({ start: issue.start, end: issue.end, replacement, custom: false });
				return this.checkText();
			}
			case 'edit': {
				if (typeof message.text !== 'string') return invalid;
				if (message.text === draft.text) return accepted;
				if (stage.phase === 'confirmed') {
					this.park();
					this.activeBranch = ++this.nextBranch;
					this.activeCopyKey = undefined;
				}
				draft.edit(message.text, [changedSpan(draft.text, message.text)]);
				return this.draftChanged();
			}
			case 'drop-action':
				if ((message.side !== 'undo' && message.side !== 'redo') || !index(message.index)) return invalid;
				if (!draft.discardAction(message.side, message.index)) return blocked;
				return message.side === 'redo' ? this.commit(this.notice) : this.draftChanged();
			case 'undo': case 'redo': case 'restore':
				return draft[message.type]() ? this.draftChanged() : blocked;
			case 'review':
				if (draft.state !== 'editor' || !draft.text.trim()) return blocked;
				draft.submit();
				return this.draftChanged();
			case 'correct': {
				if (!index(message.start) || typeof message.text !== 'string') return invalid;
				const flag = draft.flags.find(word => word.start === message.start);
				if (draft.state !== 'review' || !flag) return blocked;
				const replacement = this.parseReplacement(message.text, flag.start, flag.end);
				if (!replacement || flag.text === replacement) return blocked;
				if (replacementCaseMismatch(flag.text, replacement)) this.noteReplacement('casing-mismatch', flag.start, flag.end);
				this.replace(flag.start, flag.end, replacement);
				return this.draftChanged();
			}
			case 'keep':
				if (!index(message.start) || (message.scope !== 'occurrence' && message.scope !== 'term') ||
					(message.reason !== undefined && typeof message.reason !== 'string')) return invalid;
				return draft.keep(message.start, message.scope, draft.revision, message.reason) ? this.draftChanged() : blocked;
			case 'validate': {
				if (!index(message.start) || !index(message.end) || (message.scope !== 'occurrence' && message.scope !== 'term') ||
					(message.reason !== undefined && typeof message.reason !== 'string')) return invalid;
				if (this.batch && this.batch.status !== 'ready') return blocked;
				const issues = this.batch ? this.batch.issues : draft.state === 'review' ? draft.flags : stage.phase === 'harper-reviewed' ? stage.harper.groups :
					draft.state === 'editor' && this.lastPreview?.version === this.version ? this.lastPreview.groups : [];
				const issue = issues.find(item => item.start === message.start && item.end === message.end);
				if (!issue) return blocked;
				const text = draft.text.slice(issue.start, issue.end);
				if (message.scope === 'term' && !text.trim()) return blocked;
				const word = draft.flags.find(flag => flag.start === issue.start && flag.end === issue.end);
				draft.approve(word ?? { start: issue.start, end: issue.end, text }, message.scope, message.reason, true);
				if (this.batch) return this.checkText();
				if (stage.phase === 'harper-reviewed') this.stage = { ...stage, harper: this.checked(stage.harper) };
				return this.commit();
			}
			case 'revoke':
				if (!index(message.id)) return invalid;
				return draft.revoke(message.id) ? this.draftChanged() : blocked;
			case 'harper': case 'rewrite': {
				const handoff = draft.advance();
				if (!handoff || (stage.phase !== 'ready' && stage.phase !== 'harper-reviewed')) return blocked;
				if (message.type === 'harper' && stage.phase !== 'ready') return blocked;
				return message.type === 'harper' ? this.startEffect({ phase: 'checking-harper' }, handoff) : this.startRewrite(stage, handoff);
			}
			case 'cancel':
				if (stage.phase !== 'rewriting' && stage.phase !== 'checking-harper') return blocked;
				this.cancel();
				return accepted;
			case 'apply-harper': {
				if (!index(message.finding) || !index(message.suggestion)) return invalid;
				if (stage.phase !== 'harper-reviewed') return blocked;
				const edit = stage.harper.findings[message.finding]?.suggestions[message.suggestion];
				if (!edit) return blocked;
				const original = draft.text.slice(edit.start, edit.end);
				if (original === edit.replacement || !isWordReplacement(original, edit.replacement)) return blocked;
				if (replacementCaseMismatch(original, edit.replacement)) this.noteReplacement('casing-mismatch', edit.start, edit.end);
				this.replace(edit.start, edit.end, edit.replacement);
				draft.submit();
				return this.draftChanged('Harper suggestion applied.');
			}
			case 'confirm-rewrite': case 'keep-draft': {
				if (!index(message.proposalId)) return invalid;
				if (stage.phase !== 'proposal' || stage.rewrite.id !== message.proposalId) return blocked;
				const wording = message.type === 'keep-draft' ? stage.rewrite.text : message.wording;
				if (typeof wording !== 'string' || !wording.trim()) return { status: 'invalid', notice: 'Enter wording before confirming.' };
				if (message.type === 'confirm-rewrite') {
					if (stage.rewrite.review.wording !== wording || stage.rewrite.review.status === 'failed') return this.checkWording(wording);
					if (stage.rewrite.review.status !== 'ready') return blocked;
				}
				this.stage = { ...stage, phase: 'confirmed', rewrite: { ...stage.rewrite, confirmed: wording } };
				return this.commit('Wording confirmed.');
			}
			default: return invalid;
		}
	}

	private replace(start: number, end: number, text: string, checkRepetition = false) {
		const before = this.draft.text;
		const repeatedWords = checkRepetition ? repeatedReplacementWords(text).map(word => ({
			start: start + word.start, end: start + word.end,
		})) : [];
		this.draft.edit(before.slice(0, start) + text + before.slice(end),
			[{ rangeOffset: start, rangeLength: end - start, text }], repeatedWords);
	}

	private startEffect(job: ActiveJob, handoff: HarperHandoff, useReviewed = false): CommandResult {
		this.stage = job;
		// Keeping reviewed wording creates a proposal synchronously, with no model job to show.
		if (!useReviewed) this.commit();
		if (this.stage === job) void this.runEffect(job, handoff, useReviewed);
		return accepted;
	}
}
