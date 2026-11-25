import { listActions, mapRange, omitAction, TextReplay, spliceBetween, textActionLabel, type HistorySide } from './action-history';
import type { Choice } from './text-review';
import { asciiWords, detectMarkov, markovBaseline, type MarkovOptions, type MarkovWord, type MarkovFinding, type TextSpan } from './markov';

export type MarkovRun = Readonly<{ text: string; options: MarkovOptions; cached: boolean;
	findings: readonly MarkovFinding[]; flags: readonly MarkovWord[] }>;
type MarkovObserver = (run: MarkovRun) => void;
type Approval = Readonly<{ id: number; word: TextSpan & { text: string; score?: number }; advisory?: true; scope: 'term' | 'occurrence'; reason?: string }>;
export type DraftSnapshot = Readonly<{ text: string; approvals: readonly Approval[]; choices: readonly Choice[];
	repeatedWords: readonly TextSpan[]; inTextReview: boolean; reviewed: boolean }>;
export type DraftTimeline = Readonly<{ current: DraftSnapshot; past: DraftSnapshot[]; future: DraftSnapshot[] }>;
export type TextChange = Readonly<{ rangeOffset: number; rangeLength: number; text: string }>;
export type ReviewState = 'editor' | 'review' | 'ready';
export type HarperHandoff = Readonly<{ revision: number; text: string }>;

function historyPreview(snapshot: DraftSnapshot | undefined) {
	if (!snapshot) return undefined;
	const text = snapshot.text.trim();
	const prefix = text.match(/^.{0,60}/su)?.[0] ?? '';
	return {
		excerpt: prefix.trimEnd().replace(/\s+/g, ' ') + (prefix.length < text.length ? '…' : ''),
		keptCount: snapshot.approvals.length,
	};
}

// Change ranges refer to the original UTF-16 text. Ambiguous edits cannot carry an occurrence approval.
function verifiedChanges(before: string, after: string, changes: readonly TextChange[]): readonly TextChange[] | undefined {
	const sorted = [...changes].sort((a, b) => a.rangeOffset - b.rangeOffset);
	const parts: string[] = [];
	let cursor = 0;
	let lastOffset = -1;
	for (const { rangeOffset, rangeLength, text } of sorted) {
		if (!Number.isSafeInteger(rangeOffset) || !Number.isSafeInteger(rangeLength) || rangeLength < 0 ||
			rangeOffset < cursor || rangeOffset === lastOffset || rangeOffset + rangeLength > before.length) return;
		parts.push(before.slice(cursor, rangeOffset), text);
		cursor = rangeOffset + rangeLength;
		lastOffset = rangeOffset;
	}
	parts.push(before.slice(cursor));
	return parts.join('') === after ? sorted : undefined;
}

// Match the literal on word boundaries, including phrases and non-ASCII Harper findings.
const letter = /[\p{L}\p{M}]/u;
function literalAt(text: string, value: string, start: number) {
	const end = start + value.length;
	return text.startsWith(value, start) &&
		!(letter.test(value[0]) && letter.test(text[start - 1] ?? '')) &&
		!(letter.test(value[value.length - 1]) && letter.test(text[end] ?? ''));
}

function* matchesOf(text: string, value: string) {
	if (!value) return;
	for (let from = 0; from < text.length;) {
		const start = text.indexOf(value, from);
		if (start < 0) break;
		from = start + 1;
		if (literalAt(text, value, start)) yield { start, end: start + value.length, text: value };
	}
}

function rebaseApprovals(approvals: readonly Approval[], before: string, after: string, changes: readonly TextChange[]): readonly Approval[] {
	if (!approvals.length) return approvals;
	const edits = verifiedChanges(before, after, changes);
	const tokens = asciiWords(after);
	const firstByTerm = new Map<string, typeof tokens[number]>();
	const byStart = new Map(tokens.map(word => [word.start, word]));
	for (const token of tokens) {
		if (!firstByTerm.has(token.text)) firstByTerm.set(token.text, token);
	}
	return approvals.flatMap(approval => {
		const word = approval.word;
		let token;
		if (approval.scope === 'term') {
			token = approval.advisory ? matchesOf(after, word.text).next().value : firstByTerm.get(word.text);
		} else {
			if (!edits) return [];
			let offset = word.start;
			for (const edit of edits) {
				if (edit.rangeOffset >= word.end) break;
				if (edit.rangeOffset + edit.rangeLength > word.start) return [];
				offset += edit.text.length - edit.rangeLength;
			}
			if (approval.advisory) {
				const end = offset + word.text.length;
				if (word.text && literalAt(after, word.text, offset)) token = { start: offset, end, text: word.text };
			} else token = byStart.get(offset);
		}
		return token?.text === word.text ? [{ ...approval, word: { ...word, ...token } }] : [];
	});
}

function moveSpan<T extends TextSpan>(item: T, from: string, onto: string, replay?: TextReplay): T | undefined {
	const range = replay ? replay.range(item.start, item.end) : mapRange(item.start, item.end, from, onto);
	return onto.slice(range.start, range.end) === from.slice(item.start, item.end) ? { ...item, ...range } : undefined;
}

function carryRepeatedWords(words: readonly TextSpan[], before: string, after: string, changes: readonly TextChange[]) {
	if (!words.length) return [];
	const edits = verifiedChanges(before, after, changes);
	if (!edits) return [];
	const tokens = new Map(asciiWords(after).map(word => [word.start, word]));
	return words.flatMap(word => {
		let shift = 0;
		for (const edit of edits) {
			if (edit.rangeOffset >= word.end) break;
			if (edit.rangeOffset + edit.rangeLength > word.start) return [];
			shift += edit.text.length - edit.rangeLength;
		}
		const token = tokens.get(word.start + shift);
		return token?.end === word.end + shift ? [{ start: token.start, end: token.end }] : [];
	});
}

function actionLabel(from: DraftSnapshot, to: DraftSnapshot): string {
	if (from.text !== to.text) return textActionLabel(from.text, to.text);
	const approval = to.approvals.find(a => !from.approvals.some(b => a.id === b.id));
	if (approval) return (approval.scope === 'term' ? 'Accept all' : 'Accept once') + ' “' + approval.word.text + '”';
	const revoked = from.approvals.find(a => !to.approvals.some(b => a.id === b.id));
	if (revoked) return 'Revoke “' + revoked.word.text + '”';
	const choice = to.choices.find(a => !from.choices.some(b => a.start === b.start && a.end === b.end && a.replacement === b.replacement));
	return choice ? '“' + to.text.slice(choice.start, choice.end) + '” → “' + choice.replacement + '”' : 'Review wording';
}

// Reapply just the changes made by this action. Surviving decisions follow their literal spans.
function replayDraft(from: DraftSnapshot, to: DraftSnapshot, onto: DraftSnapshot, alignment: TextReplay): DraftSnapshot {
	const text = alignment.apply(from.text, to.text, onto.text);
	const edit = spliceBetween(onto.text, text);
	const changes = text === onto.text ? [] : [{ rangeOffset: edit.start, rangeLength: edit.end - edit.start, text: edit.text }];
	let approvals = rebaseApprovals(onto.approvals, onto.text, text, changes)
		.filter(a => !from.approvals.some(old => old.id === a.id) || to.approvals.some(next => next.id === a.id));
	for (const a of to.approvals) {
		if (from.approvals.some(old => old.id === a.id)) continue;
		const word = moveSpan(a.word, to.text, text, alignment) ?? (a.scope === 'term' ? matchesOf(text, a.word.text).next().value : undefined);
		if (word) approvals = [...approvals, { ...a, word }];
	}
	let choices = onto.choices.flatMap(c => moveSpan(c, onto.text, text) ?? []);
	const prior = from.choices.flatMap(c => moveSpan(c, from.text, to.text) ?? []);
	for (const c of [...prior, ...to.choices]) {
		const key = (v: Choice) => v.start === c.start && v.end === c.end;
		const old = prior.find(key), next = to.choices.find(key);
		if (old?.replacement === next?.replacement && old?.custom === next?.custom) continue;
		const target = moveSpan(c, to.text, text, alignment);
		if (!target) continue;
		choices = choices.filter(v => v.start !== target.start || v.end !== target.end);
		if (next) choices.push({ ...next, start: target.start, end: target.end });
	}
	const repeatedWords = carryRepeatedWords(onto.repeatedWords, onto.text, text, changes);
	for (const word of to.repeatedWords) {
		const previous = moveSpan(word, to.text, from.text);
		if (previous && from.repeatedWords.some(item => item.start === previous.start && item.end === previous.end)) continue;
		const mapped = moveSpan(word, to.text, text, alignment);
		if (mapped && !repeatedWords.some(item => item.start === mapped.start && item.end === mapped.end)) repeatedWords.push(mapped);
	}
	return { text, approvals, choices, repeatedWords, reviewed: from.reviewed === to.reviewed ? onto.reviewed : to.reviewed,
		inTextReview: from.inTextReview === to.inTextReview ? onto.inTextReview : to.inTextReview };
}

export class RequestReview {
	private currentState: ReviewState = 'editor';
	private currentRevision = 0;
	private currentText: string;
	private unresolved: readonly MarkovWord[] = [];
	private kept: readonly Approval[] = [];
	private nextApprovalId = 0;
	private selected: readonly Choice[] = [];
	private repeatedWords: readonly TextSpan[] = [];
	inTextReview = false;
	get choices() { return this.selected; }
	private detected?: { words: readonly MarkovWord[]; findings: readonly MarkovFinding[] };

	private readonly options: MarkovOptions;
	private initial: DraftSnapshot;
	private past: DraftSnapshot[] = [];
	private future: DraftSnapshot[] = [];

	constructor(text: string, options: MarkovOptions = {}, private readonly fork?: (abandoned: DraftTimeline) => void,
		private readonly observe?: MarkovObserver) {
		this.options = { ...options, windowSizes: [...(options.windowSizes ?? markovBaseline.windowSizes)] };
		this.currentText = text;
		this.initial = this.snapshot();
	}

	get state() { return this.currentState; }
	get revision() { return this.currentRevision; }
	get text() { return this.currentText; }
	get flags() { return this.unresolved; }
	get approvals() { return this.kept; }

	get history() {
		return {
			undoCount: this.past.length,
			redoCount: this.future.length,
			previous: historyPreview(this.past.at(-1)),
			next: historyPreview(this.future.at(-1)),
			canUndo: this.past.length > 0,
			canRedo: this.future.length > 0,
			canRestore: this.text !== this.initial.text || this.approvals.length > 0,
		};
	}

	private snapshot(): DraftSnapshot {
		return { text: this.text, approvals: this.approvals, choices: this.choices, repeatedWords: this.repeatedWords,
			inTextReview: this.inTextReview, reviewed: this.state === 'ready' || this.state === 'review' };
	}

	private recordChange(): void {
		if (this.future.length && this.fork) {
			// Keep the old line at its tip. Undo on that line can reach the common ancestor.
			this.fork({ current: this.future[0], past: this.past.concat(this.snapshot(), this.future.slice(1).reverse()), future: [] });
		}
		this.past.push(this.snapshot());
		this.future.length = 0;
	}

	timeline(): DraftTimeline {
		return { current: this.snapshot(), past: this.past.slice(), future: this.future.slice() };
	}

	checkpointInitial(): DraftSnapshot { return this.initial; }

	reset(initial: DraftSnapshot): void {
		this.initial = initial;
		this.past = [];
		this.future = [];
		this.load(initial, false);
	}

	resume(timeline: DraftTimeline, recompute = true): void {
		this.past = timeline.past.slice();
		this.future = timeline.future.slice();
		this.load(timeline.current, recompute);
	}

	private load(snapshot: DraftSnapshot, recompute = true): void {
		this.currentText = snapshot.text;
		this.kept = snapshot.approvals;
		this.selected = snapshot.choices;
		this.repeatedWords = snapshot.repeatedWords;
		this.inTextReview = snapshot.inTextReview;
		this.currentRevision++;
		this.detected = undefined;
		this.unresolved = [];
		this.currentState = 'editor';
		if (snapshot.reviewed && recompute) this.submit();
	}

	actionList(side: HistorySide) { return listActions(this.timeline(), side, actionLabel); }

	discardAction(side: HistorySide, index: number): boolean {
		const alignment = new TextReplay();
		const next = omitAction(this.timeline(), side, index, (from, to, onto) => replayDraft(from, to, onto, alignment));
		if (!next) return false;
		if (side === 'redo') this.future = next.future;
		else this.resume(next);
		return true;
	}

	undo(): boolean {
		const previous = this.past.pop();
		if (!previous) return false;
		this.future.push(this.snapshot());
		this.load(previous);
		return true;
	}

	redo(): boolean {
		const next = this.future.pop();
		if (!next) return false;
		this.past.push(this.snapshot());
		this.load(next);
		return true;
	}

	restore(): boolean {
		if (!this.history.canRestore) return false;
		this.recordChange();
		this.load(this.initial);
		return true;
	}

	withoutValidated<T extends TextSpan>(spans: readonly T[]): readonly T[] {
		const validated = this.kept.filter(item => item.advisory);
		if (!validated.length || !spans.length) return spans;
		const ranges = validated.flatMap(item =>
			item.scope === 'term' ? [...matchesOf(this.text, item.word.text)] : [item.word]);
		return spans.filter(span => !ranges.some(range => span.start >= range.start && span.end <= range.end &&
			(span.start < range.end || span.start === range.start)));
	}

	replacementFlags(): readonly TextSpan[] {
		return this.withoutValidated(this.repeatedWords);
	}

	previewFlags(observe = this.observe): readonly MarkovWord[] {
		const cached = !!this.detected;
		if (!this.detected) {
			const words = new Map<number, MarkovWord>();
			const findings = detectMarkov(this.text, this.options);
			for (const finding of findings) {
				for (const word of finding.suspiciousWords) words.set(word.start, word);
			}
			this.detected = { words: [...words.values()].sort((a, b) => a.start - b.start), findings };
		}
		const terms = new Set(this.kept.filter(item => item.scope === 'term').map(item => item.word.text));
		const occurrences = new Set(this.kept.filter(item => !item.advisory && item.scope === 'occurrence').map(item => item.word.start));
		const flags = this.withoutValidated(this.detected.words.filter(word => !terms.has(word.text) && !occurrences.has(word.start)));
		observe?.({text: this.text, options: {...markovBaseline, ...this.options}, cached, findings: this.detected.findings, flags});
		return flags;
	}

	submit(): void {
		// Markov checking is synchronous. Only the completed decision is observable.
		this.unresolved = this.previewFlags();
		this.currentState = !this.text.trim() ? 'editor' : this.flags.length ? 'review' : 'ready';
	}

	choose(choice: Choice): void {
		this.recordChange();
		this.selected = [...this.selected.filter(item => item.start !== choice.start || item.end !== choice.end), choice];
	}

	projectedFlags(text: string, changes: readonly TextChange[], observe = this.observe) {
		const projected = new RequestReview(text, this.options);
		projected.kept = rebaseApprovals(this.kept, this.text, text, changes);
		return projected.previewFlags(observe);
	}

	finalize(text: string, changes: readonly TextChange[]): void {
		if (text !== this.text) this.edit(text, changes);
		else if (this.inTextReview) this.recordChange();
		this.inTextReview = false;
		this.selected = [];
		this.submit();
	}

	edit(text: string, changes: readonly TextChange[] = [], repeatedWords: readonly TextSpan[] = []): void {
		if (text === this.text) return;
		this.recordChange();
		const recheck = this.state === 'review';
		this.kept = rebaseApprovals(this.kept, this.text, text, changes);
		this.repeatedWords = [...carryRepeatedWords(this.repeatedWords, this.text, text, changes), ...repeatedWords];
		if (this.selected.length) {
			const edits = verifiedChanges(this.text, text, changes);
			this.selected = edits ? this.selected.flatMap(choice => {
				let shift = 0;
				for (const edit of edits) {
					if (edit.rangeOffset >= choice.end) break;
					if (edit.rangeOffset + edit.rangeLength > choice.start) return [];
					shift += edit.text.length - edit.rangeLength;
				}
				return [{ ...choice, start: choice.start + shift, end: choice.end + shift }];
			}) : [];
		}
		this.currentText = text;
		this.currentRevision++;
		this.detected = undefined;
		this.unresolved = [];
		if (recheck) this.submit();
		else this.currentState = 'editor';
	}

	keep(start: number, scope: Approval['scope'], revision: number, reason?: string): boolean {
		const word = this.flags.find(flag => flag.start === start);
		if (this.state !== 'review' || revision !== this.revision || !word) return false;
		return this.approve(word, scope, reason);
	}

	approve(word: Approval['word'], scope: Approval['scope'], reason?: string, advisory?: true): boolean {
		this.recordChange();
		const wording = reason?.trim();
		this.kept = [...this.kept, { id: this.nextApprovalId++, scope, word, ...(advisory && { advisory }), ...(wording ? { reason: wording } : {}) }];
		if (this.state !== 'editor') this.submit();
		return true;
	}

	revoke(id: number): boolean {
		if (!this.kept.some(approval => approval.id === id)) return false;
		this.recordChange();
		this.kept = this.kept.filter(approval => approval.id !== id);
		// Removing an approval in the editor must still leave explicit submission to the user.
		if (this.state !== 'editor') this.submit();
		return true;
	}

	advance(): HarperHandoff | undefined {
		if (this.state === 'ready') {
			return { revision: this.revision, text: this.text };
		}
		return undefined;
	}
}
