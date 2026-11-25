import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import { listActions, omitAction, TextReplay, textActionLabel } from './core/action-history';
import type { ReviewLogs } from './core/review-logs';
import { parseStepId } from './core/step-id';
import { ReviewWorkflow } from './core/review-workflow';
import { inputHighlights } from './core/input-highlights';
import { promptPreview, reviewedSections, withReviewedMapping } from './core/clarification';
import { includeContextSources } from './core/context-sources';
import { mappingSections } from './core/mapping-summary';
import { returnToInput } from './core/step-three';
import type { ClarificationResources } from './clarification-resources';
import { taskLabels, modalities } from './core/prompt-mapping';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { acceptsSetting, type PanelSettings, type SettingKey, type SettingsPage } from './review-settings';
import type { HomePrompt, HomeState } from './project-context/vscode-views';
import type { PromptRef, PromptSummary, RecentAction, RecentPrompt } from './project-context/prompt-recents';

function icon(name: string): string {
	return `<span class="codicon codicon-${name}" aria-hidden="true"></span>`;
}

export type PanelPage = 'home' | 'recents' | 'draft' | 'logs' | SettingsPage;
type HomeAction = 'last' | 'new' | 'scratch' | 'recents';
type StagedInput = {flow: ReviewWorkflow; id: number; branch: number; base: string; dispose: () => void};
type PanelServices = {
	logs: ReviewLogs;
	settings(): PanelSettings;
	update(key: SettingKey, value: unknown): Promise<void>;
	openSettings(): Promise<void>;
	openProjectContext(): Promise<void>;
	homeState(): Promise<HomeState>;
	homeAction(action: HomeAction, lastPrompt?: HomePrompt): Promise<void>;
	recentPrompts(): Promise<RecentPrompt[]>;
	recentAction(action: RecentAction, prompt: PromptRef): Promise<PromptSummary | void>;
	saveAgentReadyCopy(text: string, version: number): Promise<boolean>;
};
type LogQuery = {type: 'log-list' | 'log-read'; id?: unknown; token?: unknown; before?: unknown; seq?: unknown};

function positiveInteger(value: unknown): value is number {
	return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

async function respondToLogQuery(logs: ReviewLogs, query: LogQuery, post: (message: unknown) => void) {
	const id = parseStepId(query.id);
	const {type, token} = query;
	if (!id) {
		if (type === 'log-list') post({type: 'log-invalid', token});
		return;
	}
	if (!Number.isSafeInteger(token)) return;
	if (type === 'log-list') {
		const before = query.before ?? Number.MAX_SAFE_INTEGER;
		if (!positiveInteger(before)) return;
		const page = await logs.listPage(id, before);
		post({type, id, token, ...page});
	} else if (positiveInteger(query.seq)) {
		const run = await logs.read(id, query.seq);
		post({type, id, token, seq: query.seq, run});
	}
}

export class ReviewEditor implements vscode.WebviewViewProvider {
	private readonly clarificationResources?: ClarificationResources;
	constructor(private readonly extensionUri: vscode.Uri, private readonly workflow = new ReviewWorkflow(), private readonly panels?: PanelServices) {
		if (workflow.snapshot.clarificationEnabled) {
			const {ClarificationResources} = require('./clarification-resources') as typeof import('./clarification-resources');
			this.clarificationResources = new ClarificationResources(workflow);
		}
	}
	private scratch?: {frameId: string; editVersion: number; value: unknown};
	private route: {page: PanelPage; id?: string; key?: SettingKey; resume?: boolean} = {page: 'draft'};
	private inTree = false;
	private treeLease?: () => void;
	private parkedInput?: StagedInput;
	dispose() { this.parkedInput?.dispose(); this.treeLease?.(); this.clarificationResources?.dispose(); }
	parkPanel() {
		this.inTree = true;
		this.treeLease ??= this.workflow.subscribe(() => {});
	}
	resumePanel() {
		this.inTree = false;
		if (this.clients.size) { this.treeLease?.(); this.treeLease = undefined; }
	}
	private readonly clients = new Set<(message: unknown) => void>();
	showPage(page: PanelPage, target: {id?: string; key?: SettingKey; resume?: boolean} = {}) {
		if (page === 'logs' && !this.panels?.settings().enabled) return;
		this.route = {page, ...target};
		for (const post of this.clients) post({type: 'panel-page', ...this.route});
	}
	refreshSettings() {
		const settings = this.panels?.settings();
		if (this.route.page === 'logs' && !settings?.enabled) this.showPage('draft');
		for (const post of this.clients) post({type: 'panel-settings', settings});
	}

	resolveWebviewView(view: vscode.WebviewView): void {
		const { webview } = view;
		const { workflow } = this;
		const media = vscode.Uri.joinPath(this.extensionUri, 'media');
		webview.options = { enableScripts: true, localResourceRoots: [media] };
		let disposed = false;
		let handling = false;
		let homeRequest = 0;
		let homePrompt: HomePrompt | undefined;
		let homeActionPending = false;
		let recentsRequest = 0;
		let recentPrompts: RecentPrompt[] = [];
		let recentActionPending = false;
		let copying = false;
		let previewGeneration = 0;
		let staged = this.parkedInput;
		this.parkedInput = undefined;
		const postInput = () => {
			if (!staged) return;
			const { text, history, canNext, entryStatus, notice, version } = staged.flow.snapshot;
			post({ type: 'input-preview', id: staged.id, branch: staged.branch, base: staged.base, text, canNext, entryStatus, notice,
				version, stepId: staged.flow.stepIds[0], undoCount: history.undoCount, redoCount: history.redoCount, canUndo: history.canUndo, canRedo: history.canRedo });
		};
		const post = (message: unknown) => {
			// The webview may have been hidden after the transition committed. Sync restores it.
			if (!disposed) void Promise.resolve(webview.postMessage(message)).catch(() => {});
		};
		this.clients.add(post);
		const showRecents = async () => {
			const request = ++recentsRequest;
			const rows = await this.panels!.recentPrompts();
			if (request !== recentsRequest || this.route.page !== 'recents') return;
			recentPrompts = rows;
			post({type: 'recents-state', rows});
		};
		const sidebarSnapshot = () => {
			const state = workflow.snapshot;
			const mapping = state.mapping;
			const frame = mapping && 'frame' in mapping ? mapping : undefined;
			if (this.scratch && (!frame || frame.frame.id !== this.scratch.frameId || frame.editVersion !== this.scratch.editVersion)) this.scratch = undefined;
			const preview = frame && promptPreview(frame, state.rewrite?.checkedWording ?? '');
			const stepThreeMapping = state.clarification?.mapping;
			if (preview?.text !== undefined) preview.text = includeContextSources(preview.text, workflow.contextSources);
			return {...state, preview, clarificationSections: stepThreeMapping &&
				mappingSections(stepThreeMapping.frame, stepThreeMapping.parsed, stepThreeMapping.wording),
				tasks:taskLabels, modes:modalities, scratch:this.scratch?.value, sections: mapping && 'frame' in mapping
				? reviewedSections(mapping, state.rewrite?.checkedWording ?? '') : undefined};
		};
		const unsubscribe = workflow.subscribe(() => {
			if (!handling) post({ type: 'snapshot', ...sidebarSnapshot() });
		});
		if (staged) {
			const old = staged.dispose; staged.dispose = staged.flow.subscribe(postInput); old();
		}
		if (!this.inTree) this.resumePanel();
		const subscription = webview.onDidReceiveMessage(async message => {
			if (disposed || !message || typeof message !== 'object') return;
			const panels = this.panels;
			if (panels) {
				try {
					switch (message.type) {
						case 'open-settings':
							this.parkPanel();
							await panels.openSettings();
							return;
						case 'open-project-context':
							this.parkPanel();
							await panels.openProjectContext();
							return;
						case 'panel-page':
							if (message.page === 'home' || message.page === 'recents' || message.page === 'draft' || message.page === 'logs') this.showPage(message.page, {id: parseStepId(message.id)});
							return;
						case 'home-state': {
							if (this.route.page !== 'home') return;
							const request = ++homeRequest;
							const {canStartProjectPrompt, lastPrompt} = await panels.homeState();
							if (request !== homeRequest || this.route.page !== 'home') return;
							homePrompt = lastPrompt;
							post({type: 'home-state', state: {canStartProjectPrompt, lastPrompt: lastPrompt && {
								title: lastPrompt.title, project: lastPrompt.project, updatedAt: lastPrompt.updatedAt,
							}}});
							return;
						}
						case 'home-action':
							if (this.route.page === 'home' && !homeActionPending &&
								(message.action === 'last' || message.action === 'new' || message.action === 'scratch' || message.action === 'recents')) {
								homeActionPending = true;
								try { await panels.homeAction(message.action, homePrompt); }
								finally { homeActionPending = false; }
							}
							return;
						case 'recents-state':
							if (this.route.page === 'recents') await showRecents();
							return;
						case 'recents-action': {
							const {action, projectId, promptId} = message;
							if (this.route.page !== 'recents' || recentActionPending ||
								(action !== 'continue' && action !== 'summarise' && action !== 'archive')) return;
							const prompt = recentPrompts.find(row => row.projectId === projectId && row.promptId === promptId);
							if (!prompt) throw new Error('This draft is no longer in Recents.');
							recentActionPending = true;
							try {
								const summary = await panels.recentAction(action, prompt);
								if (this.route.page === 'recents') {
									if (summary) post({type: 'recents-summary', summary});
									else await showRecents();
								}
							} finally { recentActionPending = false; }
							return;
						}
						case 'panel-setting': {
							const {key, value} = message;
							if (acceptsSetting(key, value, panels.settings())) await panels.update(key, value);
							post({type: 'panel-settings', settings: panels.settings()});
							return;
						}
						case 'copy-step-id': {
							const id = parseStepId(message.id);
							if (!id) return;
							await vscode.env.clipboard.writeText(id);
							post({type: 'id-copied', id});
							return;
						}
						case 'log-list':
						case 'log-read':
							await respondToLogQuery(panels.logs, message, post);
							return;
					}
				} catch {
					if (message.type === 'open-settings' || message.type === 'open-project-context') this.resumePanel();
					post({type: 'panel-error', action: message.type, token: message.token, settings: panels.settings()});
					return;
				}
			}
			if (message.type === 'input-highlights') {
				const state = workflow.snapshot;
				if (state.rewrite?.id !== message.proposalId || typeof message.wording !== 'string') return;
				post({type: 'input-highlights', proposalId: message.proposalId, token: message.token,
					ranges: inputHighlights(state.input ?? state.text, message.wording)});
				return;
			}
			if (message.type === 'clarification-pick-file' || message.type === 'clarification-reference') {
				const { version, questionId, field } = message;
				try {
					if (message.type === 'clarification-reference') await this.clarificationResources?.open(workflow.branchId, version, questionId);
					else {
						const files = await this.clarificationResources?.pick(version, questionId, field);
						if (files) post({type:'clarification-files', questionId, field, files});
					}
				} catch (error) {
					post({type:'clarification-resource-error', questionId, message: error instanceof Error ? error.message : 'The resource is unavailable.'});
				}
				return;
			}
			if (message.type === 'scratch') {
				const mapping = workflow.snapshot.mapping;
				if (!mapping || !('frame' in mapping) || mapping.frame.id !== message.frameId) return;
				const value = message.scratch;
				if (value === null) this.scratch = undefined;
				else if (value?.frame?.id === mapping.frame.id && mapping.editVersion === value.editVersion)
					this.scratch = {frameId:mapping.frame.id, editVersion:mapping.editVersion, value};
				return;
			}
			if (message.type === 'copy-prompt' || message.type === 'copy-ready-prompt') {
				if (copying || this.route.page !== 'draft') return;
				const state = sidebarSnapshot();
				const ready = message.type === 'copy-ready-prompt';
				const result = {type: 'copy-result', version: message.version, ready};
				let text: string | undefined;
				if (state.version === message.version && state.rewrite?.id === message.proposalId) {
					const mapping = state.clarification?.mapping;
					if (ready && state.clarification?.status === 'ready' && mapping && mapping.frame.id === message.frameId && mapping.editVersion === message.editVersion) {
						text = includeContextSources(withReviewedMapping(mapping.wording, mapping.frame, mapping.parsed), workflow.contextSources);
					} else if (!ready && state.mappingId === message.mappingId) text = state.preview?.text;
				}
				if (!text?.trim()) { post({...result, ok: false, stale: true}); return; }
				copying = true;
				try {
					let saved: boolean | undefined;
					try { saved = await panels?.saveAgentReadyCopy(text, state.version); }
					catch { post({...result, ok: false, saveFailed: true}); return; }
					try { await vscode.env.clipboard.writeText(text); post({...result, ok: true, saved}); }
					catch { post({...result, ok: false, saved}); }
				} finally { copying = false; }
				return;
			}
			if (message.type === 'action-list' || message.type === 'drop-wording-action') {
				const { side, token, wording } = message;
				if ((side !== 'undo' && side !== 'redo') || !Number.isSafeInteger(token)) return;
				if (wording) {
					if (typeof wording.current !== 'string' || ![wording.past, wording.future].every(stack =>
						Array.isArray(stack) && stack.every(item => typeof item === 'string'))) return;
					if (message.type === 'drop-wording-action') {
						const alignment = new TextReplay();
						const line = omitAction<string>(wording, side, message.index, (from, to, onto) => alignment.apply(from, to, onto));
						if (line) post({ type: 'wording-timeline', token, line });
					} else post({ type: 'action-list', token, entries: listActions<string>(wording, side, textActionLabel) });
				} else if (message.type === 'action-list') {
					const flow = message.previewId === undefined ? workflow : staged && staged.id === message.previewId ? staged.flow : undefined;
					if (flow && message.version === flow.snapshot.version) post({ type: 'action-list', token, entries: flow.actionList(side) });
				}
				return;
			}
			if (message.type === 'stage-input') {
				if (!Number.isSafeInteger(message.id) || message.branch !== workflow.branchId || typeof message.base !== 'string' ||
					message.base !== workflow.submittedInput || typeof message.text !== 'string') return;
				if (!staged || staged.branch !== message.branch || staged.base !== message.base) {
					staged?.dispose();
					const flow = workflow.createInputPreview(message.base);
					staged = { flow, branch: message.branch, base: message.base, id: message.id, dispose: flow.subscribe(postInput) };
				}
				staged.id = message.id;
				const flow = staged.flow;
				const { version, revision } = flow.snapshot;
				const type = ['undo','redo','retry-text-review','drop-action'].includes(message.action) ? message.action : 'edit';
				if (type !== 'drop-action' || message.historyVersion === version) {
					flow.dispatch({ type, version, revision, text: message.text, side: message.side, index: message.index });
				}
				if (flow.snapshot.version === version) postInput();
				return;
			}
			if (message.type === 'replacement-clipped') {
				workflow.dispatch(message);
				return;
			}
			if (message.type === 'replacement-candidates') {
				const result = await workflow.replacementCandidates(message.version, message.revision, message.start);
				if (result) post({ type: 'replacement-candidates', ...result });
				return;
			}
			if (message.type === 'preview-flags') {
				const { id, revision, version } = message;
				if (!Number.isSafeInteger(id) || id < 0 || !workflow.isDraftVersion(version, revision)) return;
				const generation = ++previewGeneration;
				const preview = await workflow.preview();
				if (generation === previewGeneration && workflow.isDraftVersion(version, revision)) {
					post({ type: 'preview-flags', id, ...preview });
				}
				return;
			}
			const { requestId } = message;
			if (!Number.isSafeInteger(requestId) || requestId <= 0) return;
			// Only this sender gets its correlated acknowledgement. Other observers receive the commit.
			handling = true;
			try {
				const branch = workflow.branchId;
				const result = message.type === 'archive-input' ?
					(staged && staged.branch === workflow.branchId && staged.base === workflow.submittedInput && staged.id === message.previewId ?
						workflow.archiveAndReview(staged.flow, message.text, message.key, message.version, message.revision) : { status: 'stale' }) :
					workflow.dispatch(message);
				post({ type: 'snapshot', ...sidebarSnapshot(), requestId, ...result, ...(message.type === 'sync' && this.panels && {panel: {...this.route, settings: this.panels.settings()}}) });
				if (message.type === 'submit-clarification' && result.status === 'accepted' && typeof message.questionId === 'string') {
					void this.clarificationResources?.close(branch, message.questionId).catch(() => {});
				}
			} finally {
				handling = false;
			}
		});
		view.onDidDispose(() => {
			disposed = true;
			this.clients.delete(post);
			previewGeneration++;
			if (this.inTree && staged) { this.parkedInput?.dispose(); this.parkedInput = staged; }
			else staged?.dispose();
			subscription.dispose();
			unsubscribe();
		});
		const nonce = randomBytes(24).toString('base64');
		const script = webview.asWebviewUri(vscode.Uri.joinPath(media, 'review-editor.js'));
		const moduleScript = webview.asWebviewUri(vscode.Uri.joinPath(media, 'review-modules.js'));
		const recentsScript = webview.asWebviewUri(vscode.Uri.joinPath(media, 'review-recents.js'));
		const mappingScript = webview.asWebviewUri(vscode.Uri.joinPath(media, 'mapping-editor.js'));
		const previewBody = readFileSync(join(this.extensionUri.fsPath,'media','rule-editor.html'),'utf8');
		const treeScript = webview.asWebviewUri(vscode.Uri.joinPath(media, 'review-tree.js'));
		const questionScript = webview.asWebviewUri(vscode.Uri.joinPath(media, 'review-clarification.js'));
		const stylesheet = webview.asWebviewUri(vscode.Uri.joinPath(media, 'review-editor.css'));
		const recentsStyles = webview.asWebviewUri(vscode.Uri.joinPath(media, 'review-recents.css'));
		const glyph = (path: string) => `<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${path}"/></svg>`;
		const actionButton = (id: string, name: string, drawing: string) =>
			`<button id="${id}" type="button" aria-label="${name}" title="${name}">${drawing}</button>`;
		webview.html = `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta name="viewport" content="width=device-width, initial-scale=1">
	<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}'; style-src ${webview.cspSource}; font-src ${webview.cspSource};">
	<title>Review request</title>
	<link rel="stylesheet" href="${stylesheet}">
	<link rel="stylesheet" href="${recentsStyles}">
</head>
<body>
	<aside class="panel-rail" aria-label="Modules">
		<button id="focus-home" type="button" aria-label="Home" title="Home"${this.route.page === 'home' ? ' aria-current="page"' : ''}>${glyph('M2 7l6-5 6 5v7H9.5v-4h-3v4H2z')}</button>
		<button id="focus-recents" type="button" aria-label="Recents" title="Recents"${this.route.page === 'recents' ? ' aria-current="page"' : ''}>${icon('history')}</button>
		<button id="focus-draft" type="button" aria-label="Focus draft" title="Focus draft"${this.route.page === 'draft' ? ' aria-current="page"' : ''}>${icon('edit')}</button>
		${actionButton('open-project-context', 'Project Context', glyph('M2 4h4l1.5 2H14v7H2zM5 8.5h6M5 10.5h4'))}
		<div class="rail-bottom">
			${actionButton('open-settings', 'Settings', icon('settings-gear'))}
			<button id="open-logs" type="button" aria-label="Logs" title="Logs" hidden>${icon('output')}</button>
		</div>
	</aside>
	<main class="workbench">
		<section class="home-page" id="home-page" aria-labelledby="home-heading"${this.route.page === 'home' ? '' : ' hidden'}>
			<header><h2 id="home-heading">Home</h2><span>DWI</span></header>
			<section class="home-feature" id="home-last" aria-label="Last saved prompt" hidden>
				<div class="home-caption">${icon('history')} Last saved prompt</div>
				<h3 id="home-last-title"></h3>
				<p class="home-meta" id="home-last-meta"></p>
				<button class="home-primary" id="home-open-last" type="button">Open last prompt ${glyph('M3 8h10M9 4l4 4-4 4')}</button>
			</section>
			<div class="home-actions">
				<button class="home-action" id="home-new-prompt" type="button" disabled>${glyph('M8 3v10M3 8h10')}<span id="home-new-label">New project prompt</span></button>
				<button class="home-action" id="home-scratch" type="button">${icon('edit')} Open Scratch</button>
			</div>
			<button class="home-link" id="home-recents" type="button" hidden>View recent prompts ${icon('chevron-right')}</button>
			<p id="home-status" role="status"></p>
		</section>
		<section class="recents-page" id="recents-page" aria-labelledby="recents-heading"${this.route.page === 'recents' ? '' : ' hidden'}>
			<header><button id="recents-back" type="button" aria-label="Back to Recents" hidden>${icon('arrow-left')}</button><h2 id="recents-heading" tabindex="-1">Recents</h2></header>
			<div id="recents-list-space"><ul id="recents-list" aria-label="Draft prompts"></ul><p id="recents-status" role="status"></p></div>
			<footer>
				<button class="home-link" id="recents-all" type="button" hidden>View all ${icon('chevron-right')}</button>
				<nav id="recents-pagination" aria-label="Prompt pages" hidden>
					<span id="recents-range" aria-live="polite"></span>
					<button id="recents-prev" type="button" aria-label="Previous page">${icon('chevron-left')}</button>
					<button id="recents-next" type="button" aria-label="Next page">${icon('chevron-right')}</button>
				</nav>
			</footer>
			<div id="recents-menu" role="menu" aria-label="Prompt actions" popover="manual">
				<button type="button" role="menuitem" tabindex="-1" data-action="continue">Continue</button>
				<button type="button" role="menuitem" tabindex="-1" data-action="summarise">Summarise</button>
				<button type="button" role="menuitem" tabindex="-1" data-action="archive">Archive</button>
			</div>
			<dialog id="recents-summary" aria-labelledby="recents-summary-title">
				<h2 id="recents-summary-title"></h2><dl id="recents-summary-body"></dl>
				<form method="dialog"><button type="submit" autofocus>Close</button></form>
			</dialog>
		</section>
		<div class="sheet"${this.route.page === 'draft' ? '' : ' hidden'}>
			<nav class="steps" aria-label="Draft steps">
				<button id="step-1" type="button" aria-label="Step 1: Input" data-step-name="Input" aria-current="step">1</button>
				<button id="step-2" type="button" aria-label="Step 2: Suggested edits" data-step-name="Suggested edits" hidden>2</button>
				<button id="step-3" type="button" aria-label="Step 3: Rewrite" data-step-name="Rewrite" hidden>3</button>
				<button id="step-4" type="button" aria-label="Step 4: Mapping check" data-step-name="Mapping check" hidden>4</button>
			</nav>
			<div class="source-pane">
				<header class="editor-bar">
				<button id="draft-info" class="info-button" type="button" aria-label="Draft information" title="Draft information" popovertarget="info-panel">${icon('info')}</button>
				<div id="tools" class="history-controls" role="group" aria-label="Review controls">
					<div class="signal" id="signal" hidden>
						<button id="warning" type="button" aria-label="Review issues" aria-describedby="warning-tip" aria-controls="inspector">${icon('warning')}<span id="warning-count" aria-hidden="true"></span></button>
						<span id="warning-tip" role="tooltip"></span>
					</div>
					<button id="undo" type="button" aria-label="Undo" title="Undo · Hold or right-click for actions" aria-haspopup="dialog" aria-controls="action-panel" disabled>${icon('discard')}</button>
					<button id="redo" type="button" aria-label="Redo" title="Redo · Hold or right-click for actions" aria-haspopup="dialog" aria-controls="action-panel" disabled>${icon('redo')}</button>
					<button id="history" type="button" aria-label="Draft history" title="Draft history" popovertarget="history-panel" disabled>${icon('history')}</button>
				</div>
				</header>
				<div class="writing">
					<div id="source" role="textbox" aria-label="Edit original wording" aria-multiline="true" contenteditable="plaintext-only" spellcheck="false" hidden></div>
					<textarea id="request" aria-label="Request" spellcheck="false" disabled></textarea>
					<textarea id="step-input" aria-label="Original input" spellcheck="false" hidden></textarea>
					<section id="review-tree" aria-label="Prompt review" hidden>
						<div class="review-tree-row">
							<button id="input-node" class="tree-toggle" aria-expanded="true" aria-controls="tree-input" type="button">Input</button>
							${actionButton('rewrite-input', 'Rewrite input', glyph('m2 12 8-8 2 2-8 8zm6-6 2 2M4 1v4M2 3h4m6-2v3m-1.5-1.5h3'))}
							${actionButton('input-history', 'Input history', icon('history'))}
						</div>
						<div id="tree-input" class="tree-children">
							<div id="input-read" tabindex="0" role="textbox" aria-readonly="true" aria-label="Corrected input. Press Enter to edit." title="Double-click or press Enter to edit"></div>
							<textarea id="rewrite-text" aria-label="Edit wording" spellcheck="false" hidden></textarea>
							<button id="done-wording" type="button" hidden>Done</button>
							<div id="input-versions" aria-label="Input history" hidden></div>
							<p id="clarification-terminal" class="clarification-terminal" tabindex="-1" hidden>${returnToInput}</p>
						</div>
						<div id="clarification-row" class="review-tree-row" hidden><button id="clarification-node" class="tree-toggle" type="button" aria-expanded="false" aria-controls="tree-clarification"><span id="clarification-name">Awaiting clarifications</span><span id="clarification-count" aria-hidden="true"></span></button></div>
						<div id="tree-clarification" class="tree-children" hidden>
							<form id="clarification-form" novalidate>
								<fieldset id="clarification-fields"><legend id="clarification-question"></legend><div id="clarification-controls"></div></fieldset>
								<button id="clarification-reference" class="clarification-link" type="button" hidden></button>
								<div class="clarification-actions">
									<button id="clarification-back" class="subtle" type="button">Back</button>
									<button id="clarification-skip" class="subtle" type="button">Skip</button>
									<button id="clarification-next" type="submit">Next</button>
								</div>
							</form>
						</div>
						<div id="clarification-status" role="status" aria-live="polite"></div>
						<div id="clarification-alert" role="alert"></div>
						<button id="clarification-retry" class="subtle" type="button" hidden>Retry</button>
						<div class="review-tree-row"><button id="mappings-node" class="tree-toggle" aria-expanded="false" aria-controls="tree-mappings" type="button">Mappings</button></div>
						<div id="tree-mappings" class="tree-children" hidden>
							<p id="tree-status" role="status"></p><button id="tree-retry" type="button" hidden>Retry</button>
							<div id="mapping-nodes"></div>
							<button id="clarification-review" class="subtle" type="button" hidden>Review answers</button>
						</div>
					</section>
					<section id="mapping-review" class="mapping-review" aria-labelledby="heading" hidden>${previewBody}</section>
				</div>
				<p id="notice" role="status"></p>
			</div>
			<footer>
				<div class="stage-actions">
					<button class="subtle" id="review" type="button" disabled>Next</button>
					<button class="subtle" id="retry" type="button" hidden>Retry check</button>
					<button class="subtle" id="check-mapping" type="button" hidden>Next</button>
					<button class="subtle" id="mapping-back" type="button" hidden>Back to revise</button>
					<button id="copy-prompt" type="button" hidden>Copy prompt</button>
					<button id="copy-ready-prompt" type="button" hidden>Copy prompt</button>
					<button class="subtle" id="retry-mapping" type="button" hidden>Retry check</button>
				</div>
			</footer>
			<p id="copy-ready-status" role="status" hidden></p>
		</div>
		<section id="info-panel" class="popover" popover="auto" aria-label="Draft information">
			<dl><dt>Step</dt><dd id="info-step"></dd><dt>Variant</dt><dd id="info-variant"></dd>
			<dt>Undo</dt><dd id="info-undo"></dd><dt>Redo</dt><dd id="info-redo"></dd></dl>
			<div class="info-id"><span>ID</span><button type="button" id="info-id" aria-label="Open step logs" title="Open step logs"></button>
				${actionButton('copy-id', 'Copy step ID', icon('copy'))}</div>
		</section>
		<section id="settings-page" class="module-page" hidden>
			<header>${actionButton('settings-back', 'Back to settings', icon('arrow-left'))}<h2 id="settings-heading"></h2></header>
			<div id="logging-fields">
				<label class="setting-row">Enable logging<input id="logging-enabled" data-setting="logging.enabled" type="checkbox" role="switch"></label>
				<label class="setting-row">Values to log<select id="logging-source" data-setting="logging.source"><option value="none">None</option><option value="markov">Markov</option></select></label>
			</div>
			<label id="font-field" class="setting-row">Font size (px)<input type="number" id="editor-size" data-setting="editor.fontSize" min="1" max="72" placeholder="VS Code"></label>
			<p id="settings-status" role="status"></p>
		</section>
		<section id="logs-page" class="module-page" hidden aria-label="Log explorer">
			<input id="log-query" type="text" aria-label="Paste step ID" placeholder="Paste step ID" autocomplete="off" spellcheck="false">
			<div id="log-explorer" hidden>
				<h2 id="log-heading">Markov</h2><p id="log-status" role="status"></p>
				<div id="log-runs"></div><button id="log-more" type="button" hidden>More runs</button>
			</div>
		</section>
		<section id="inspector" class="popover" popover="manual" aria-label="Word actions">
			<div id="word-tools" role="toolbar" aria-label="Word actions" aria-controls="source">
				<div id="choices" role="group" aria-label="Replacement">
					${actionButton('previous', 'Previous candidate', icon('chevron-left'))}
					<div id="suggestions" role="group" aria-label="Candidates"></div>
					${actionButton('next', 'Next candidate', icon('chevron-right'))}
					${actionButton('apply-candidate', 'Apply selected correction', glyph('m2.5 8 3.5 3.5L13.5 4'))}
					${actionButton('custom', 'Custom replacement', glyph('M8 3v10M3 8h10'))}
				</div>
				<form id="correction" hidden>
					${actionButton('back', 'Back to candidates', icon('arrow-left'))}
					<input id="replacement" aria-label="Custom replacement" placeholder="Replacement" autocomplete="off">
					<button id="replace" type="submit" title="Apply replacement" aria-label="Apply replacement" disabled>${glyph('M13 3v6H3m4-4L3 9l4 4')}</button>
				</form>
				<div class="valid-actions" role="group" aria-label="Keep original wording">
					${actionButton('keep-once', 'Keep original for this occurrence', 'Keep')}
					${actionButton('keep-term', 'Keep original for all matches in this draft', 'All')}
				</div>
			</div>
		</section>
		<section id="action-panel" class="popover" popover="manual" role="dialog" aria-label="Edit actions"><ul id="action-items"></ul></section>
		<section id="history-panel" class="popover menu" popover="auto" aria-label="Draft history">
			<header class="overlay-bar history-header">
				<h2 id="history-heading">No other drafts</h2>
				<span class="restore-control">
					<button id="restore" type="button" aria-label="Restore original" disabled>${icon('debug-restart')}</button>
					<span id="restore-tip" role="tooltip">Restore original</span>
				</span>
			</header>
			<div class="history-body">
				<ul id="branches" aria-label="Other drafts"></ul>
				<details id="approvals" hidden><summary>Validated words</summary><ul id="approved"></ul></details>
			</div>
		</section>
		<dialog id="archive-dialog" aria-labelledby="archive-title">
			<h2 id="archive-title">Start a new draft?</h2>
			<p>Your current draft and its completed steps will move to History.</p>
			<div class="stage-actions">
				<button id="cancel-archive" type="button" autofocus>Keep editing</button>
				<button id="archive-input" type="button" class="action">Archive and continue</button>
			</div>
		</dialog>
	</main>
	<script nonce="${nonce}" src="${recentsScript}"></script>
	<script nonce="${nonce}" src="${moduleScript}"></script>
	<script nonce="${nonce}" src="${mappingScript}"></script>
	<script nonce="${nonce}" src="${questionScript}"></script>
	<script nonce="${nonce}" src="${treeScript}"></script>
	<script nonce="${nonce}" src="${script}"></script>
</body>
</html>`;
	}
}
