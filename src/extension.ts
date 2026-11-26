import * as vscode from 'vscode';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { SCRATCH_SCOPE, ScratchPads } from './project-context/scratch-pads';
import { ModernBertWorker } from './core/modernbert-rewrite';
import { mapWithModernBert } from './core/prompt-mapping';
import { ReviewWorkflow, localServices, type ReviewServices, type ReviewCommand } from './core/review-workflow';
import { ReviewLogs } from './core/review-logs';
import { ReviewEditor, type PanelPage } from './review-editor';
import { openContextSources } from './context-source-menu';
import { readPanelSettings, searchableSettings, settingsGroups, settingsSections, type SettingKey } from './review-settings';
import type { HomeState, ProjectContextViews } from './project-context/vscode-views';
import { isPromptValue } from './project-context/contracts';
import { summarisePrompt, type PromptRef } from './project-context/prompt-recents';

type PromptBinding = { projectId: string; promptId: string; revision: number };
type PersistedBinding = { projectId: string; promptId: string };
const LAST_SCRATCH_KEY = 'dwi.lastScratchPad';
const newPad = (): PromptBinding => ({projectId: SCRATCH_SCOPE, promptId: randomUUID(), revision: 0});
const BINDING_KEY = 'dwi.projectContext.activePrompt';
let model: ModernBertWorker | undefined;
let projectContext: vscode.Disposable | undefined;
let closeReview: (() => Promise<void>) | undefined;

export function activate(context: vscode.ExtensionContext) {
	const output = join(context.extensionUri.fsPath, 'out');
	let bundle = join(output, 'modernbert');
	if (context.extensionMode === vscode.ExtensionMode.Development) {
		try {
			const key = readFileSync(join(output, 'modernbert-cache-key'), 'utf8').trim();
			if (!/^[0-9a-f]{64}$/u.test(key)) throw new Error('Invalid ModernBERT bundle cache key.');
			bundle = join(output, '.modernbert-cache', key);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
		}
	}
	const worker = model = new ModernBertWorker({node: process.execPath, workingDirectory: bundle,
		script: join(context.extensionUri.fsPath, 'out', 'core', 'modernbert', 'worker.js')});
	let modelTail: Promise<void> = Promise.resolve();
	function runModel<T>(signal: AbortSignal, run: () => Promise<T>) {
		const operation = modelTail.then(() => {
			signal.throwIfAborted();
			return run();
		});
		modelTail = operation.then(() => {}, () => {});
		return operation;
	}
	const mapPrompt: NonNullable<ReviewServices['mapPrompt']> = (wording, signal, id) =>
		runModel(signal, () => mapWithModernBert(worker, wording, signal, id));
	return activateReview(context, {...localServices,
		rewrite: (request, signal) => runModel(signal, () => worker.rewrite(request, signal)), mapPrompt, stepThree: {map: mapPrompt}},
		{headless: false, projectContext: true});
}

export function activateReview(context: vscode.ExtensionContext, services: ReviewServices, options: {headless?: boolean; projectContext?: boolean} = {}) {
	const projectViews = options.projectContext ? new (require('./project-context/vscode-views') as typeof import('./project-context/vscode-views')).ProjectContextViews(context, beforeSelectProject) : undefined;
	projectContext = projectViews;
	const configuration = () => vscode.workspace.getConfiguration('dwiNov');
	let prefs = readPanelSettings(configuration());
	const logs = new ReviewLogs(context.globalStorageUri.fsPath, () => prefs.source === 'markov', message => { void vscode.window.showWarningMessage(message); });
	let promptBinding: PromptBinding | undefined;
	const pads = new ScratchPads(join(context.globalStorageUri.fsPath, 'scratch-pads'));
	let scratch = newPad();
	const owner = () => promptBinding ?? scratch;
	const listings = new vscode.EventEmitter<void>();
	const projectChanges = projectViews?.onDidChangeListings(() => listings.fire());
	const sessionKey = () => JSON.stringify([owner().projectId, owner().promptId]);
	const workflow = new ReviewWorkflow(services.stepThree && projectViews ? {...services, stepThree: {
		...services.stepThree,
		async context(wording, signal) {
			const projectId = promptBinding?.projectId;
			if (!projectId) return {relevance: 'unknown', references: []};
			try { return await projectViews.clarificationEvidence(projectId, wording, signal); }
			catch { signal.throwIfAborted(); return {relevance: 'unknown', references: []}; }
		}
	}} : services, logs.capture);
	let hydrating = false, actionGeneration = 0, lastSaved = JSON.stringify(workflow.exportCheckpoint());
	let saveTimer: NodeJS.Timeout | undefined, saveTail: Promise<void> = Promise.resolve(), closing: Promise<void> | undefined;
	let queuedSave: {binding: PromptBinding; serialized: string; task: Promise<void>} | undefined;
	const safe = async <T,>(label: string, operation: () => Promise<T>): Promise<T | undefined> => {
		try { return await operation(); } catch (error) { void vscode.window.showErrorMessage(`${label}: ${String(error)}`); return undefined; }
	};
	const changed = () => { if (!hydrating) { clearTimeout(saveTimer); saveTimer = setTimeout(() => { void safe('Could not save prompt', saveNow); }, 500); } };
	const saveNow = async () => {
		const binding = owner(), checkpoint = workflow.exportCheckpoint(), serialized = JSON.stringify(checkpoint);
		if (queuedSave?.binding === binding && queuedSave.serialized === serialized) return queuedSave.task;
		if (!queuedSave && serialized === lastSaved) return;
		const task = saveTail.then(async () => {
			if (owner() !== binding || serialized === lastSaved) return;
			const revision = binding.revision;
			const saved = binding.projectId === SCRATCH_SCOPE
				? await pads.save(binding.promptId, revision || null, checkpoint)
				: await projectViews!.savePrompt(binding.projectId, binding.promptId, checkpoint, revision);
			if (owner() === binding && binding.revision === revision) {
				binding.revision = saved.revision;
				lastSaved = serialized;
				if (binding.projectId === SCRATCH_SCOPE) {
					if (!revision) await context.workspaceState.update(LAST_SCRATCH_KEY, binding.promptId);
					listings.fire();
				}
			}
		});
		saveTail = task.catch(() => undefined);
		queuedSave = {binding, serialized, task};
		try { await task; } finally { if (queuedSave?.task === task) queuedSave = undefined; }
	};
	const serializedDraft = () => JSON.stringify(workflow.exportCheckpoint());
	const flushPrompt = async () => {
		const binding = owner();
		clearTimeout(saveTimer);
		saveTimer = undefined;
		await saveTail;
		while (owner() === binding && serializedDraft() !== lastSaved) await saveNow();
	};
	const flushForListing = async (): Promise<string | undefined> => {
		try { await flushPrompt(); return undefined; }
		catch (error) {
			return 'The current draft could not be saved. Showing the last saved prompts. ' +
				(error instanceof Error ? error.message : String(error));
		}
	};
	const saveAgentReadyCopy = async (text: string, version: number): Promise<boolean> => {
		const binding = owner();
		const checkpoint = workflow.exportCheckpoint();
		const task = saveTail.then(async () => {
			if (owner() !== binding || workflow.snapshot.version !== version) throw new Error('The draft changed. Review it before copying again.');
			const saved = binding.projectId === SCRATCH_SCOPE
				? await pads.save(binding.promptId, binding.revision || null, checkpoint, text)
				: await projectViews!.savePrompt(binding.projectId, binding.promptId, checkpoint, binding.revision, text);
			binding.revision = saved.revision;
			if (owner() === binding) {
				lastSaved = JSON.stringify(checkpoint);
				if (binding.projectId === SCRATCH_SCOPE) listings.fire();
			}
		});
		saveTail = task.catch(() => undefined);
		await task;
		return true;
	};
	const flushOrResolveConflict = async (): Promise<'ready' | 'stay' | 'scratch'> => {
		const original = owner();
		try { await flushPrompt(); return 'ready'; } catch (error) {
			const choice = await vscode.window.showErrorMessage(`Could not save this prompt: ${error instanceof Error ? error.message : String(error)}. Your current text is still available.`, 'Keep Editing', 'Copy to Scratch', ...(promptBinding ? ['Save as New Project Prompt'] : []));
			if (owner() !== original || choice === 'Keep Editing' || !choice) return 'stay';
			if (choice === 'Copy to Scratch') {
				workflow.cancel();
				scratch = newPad();
				lastSaved = '';
				await persistBinding();
				await flushPrompt();
				return 'scratch';
			}
			if (choice === 'Save as New Project Prompt' && promptBinding && projectViews) {
				const title = await vscode.window.showInputBox({prompt: 'Title for the new project prompt'});
				if (!title?.trim() || promptBinding !== original) return 'stay';
				const checkpoint = workflow.exportCheckpoint();
				const created = await createProjectPrompt(promptBinding.projectId, title.trim(), checkpoint);
				if (promptBinding !== original) return 'stay';
				lastSaved = JSON.stringify(checkpoint);
				await persistBinding(created);
				if (JSON.stringify(workflow.exportCheckpoint()) === lastSaved) return 'ready';
				changed();
				return 'stay';
			}
			return 'stay';
		}
	};
	const persistBinding = async (binding?: PromptBinding) => {
		promptBinding = binding;
		editor.setDraftSession(sessionKey());
		const value: PersistedBinding | undefined = binding && {projectId: binding.projectId, promptId: binding.promptId};
		await context.workspaceState.update(BINDING_KEY, value);
	};
	// Change the workflow, its save baseline, and its owner before yielding to another webview request.
	function replaceBoundDraft(binding?: PromptBinding, checkpoint: unknown = null, pad?: PromptBinding) {
		hydrating = true;
		try {
			if (!workflow.restoreCheckpoint(checkpoint)) throw new Error('Saved prompt is invalid; the current review was kept.');
			if (!binding) scratch = pad ?? newPad();
			lastSaved = JSON.stringify(workflow.exportCheckpoint());
			return persistBinding(binding);
		} finally { hydrating = false; }
	}
	// A late edit in Scratch cancels navigation so the user can finish typing.
	function startSwitch() {
		return {generation: ++actionGeneration, scratch: promptBinding ? undefined : serializedDraft()};
	}
	async function switchDraft(request: ReturnType<typeof startSwitch>, next?: PromptBinding, checkpoint: unknown = null, pad?: PromptBinding) {
		if (request.generation !== actionGeneration) return false;
		if (await flushOrResolveConflict() !== 'ready') return false;
		if (request.generation !== actionGeneration) return false;
		if (next && promptBinding?.projectId === next.projectId && promptBinding.promptId === next.promptId &&
			promptBinding.revision > next.revision) return false;
		if (promptBinding ? serializedDraft() !== lastSaved : serializedDraft() !== request.scratch) {
			void vscode.window.showInformationMessage('Your draft changed during the switch. It is still open.');
			return false;
		}
		await replaceBoundDraft(next, checkpoint, pad);
		return request.generation === actionGeneration;
	}
	async function beforeSelectProject(projectId: string): Promise<boolean> {
		const request = startSwitch();
		if (!promptBinding || promptBinding.projectId === projectId) return true;
		return switchDraft(request);
	}
	const workflowSubscription = workflow.subscribe(changed);
	const openPage = async (page: PanelPage, key?: SettingKey, resume?: boolean) => {
		editor.showPage(page, {key, resume});
		await vscode.commands.executeCommand('setContext', 'dwiNov.settingsTree', false);
		await vscode.commands.executeCommand('setContext', 'dwiNov.projectContextOpen', false);
		await vscode.commands.executeCommand('setContext', 'dwiNov.projectPromptsOpen', false);
		await vscode.commands.executeCommand('dwiNov.home.focus'); editor.resumePanel();
	};
	const openProjectContext = async () => {
		await vscode.commands.executeCommand('setContext', 'dwiNov.projectPromptsOpen', false);
		await vscode.commands.executeCommand('setContext', 'dwiNov.projectContextOpen', true);
		await vscode.commands.executeCommand('dwi.projectContext.focus');
	};
	const editor = new ReviewEditor(context.extensionUri, workflow, {
		logs, settings: () => prefs,
		async update(key, value) { await configuration().update(key, value, vscode.ConfigurationTarget.Global); },
		openSettings: async () => { await vscode.commands.executeCommand('setContext', 'dwiNov.settingsTree', true); await vscode.commands.executeCommand('dwiNov.settings.focus'); },
		openProjectContext,
		onDidChangeListings: listings.event,
		async homeState() {
			const saveWarning = await flushForListing();
			const state: HomeState = await projectViews?.homeState() ?? {canStartProjectPrompt: false, hasRecentPrompts: false};
			const [latest] = await pads.list();
			if (latest) {
				state.hasRecentPrompts = true;
				if (!state.lastPrompt || latest.updatedAt > state.lastPrompt.updatedAt) state.lastPrompt = {...latest, project: 'Scratch'};
			}
			return {...state, saveWarning};
		},
		async homeAction(action, lastPrompt) {
			if (action === 'recents') { await openPage('recents'); return; }
			if (action === 'scratch' || action === 'new-scratch') {
				await vscode.commands.executeCommand(action === 'scratch' ? 'dwiNov.scratch' : 'dwiNov.newScratch');
				return;
			}
			if (action === 'last' && lastPrompt?.projectId === SCRATCH_SCOPE) {
				await openScratch(lastPrompt.promptId);
				return;
			}
			if (!projectViews) return;
			if (action === 'new') {
				const current = await projectViews.getActiveProjectId();
				if (!current) {
					if (!(await projectViews.homeState()).canStartProjectPrompt) {
						await openProjectContext();
						return;
					}
					if (!await projectViews.selectProject()) return;
				}
				await vscode.commands.executeCommand('dwi.projectContext.new');
				return;
			}
			if (!lastPrompt) return;
			if (!await projectViews.canOpenHomePrompt(lastPrompt)) {
				editor.showPage('home');
				return;
			}
			await vscode.commands.executeCommand('dwi.projectContext.open', lastPrompt);
		},
		async recentPrompts() {
			const saveWarning = await flushForListing();
			const [projects, scratchRows] = await Promise.all([projectViews?.workingPrompts() ?? [], pads.list()]);
			return {rows: [...projects, ...scratchRows].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.promptId.localeCompare(b.promptId)), saveWarning};
		},
		async recentAction(action, prompt) {
			if (prompt.projectId === SCRATCH_SCOPE) {
				if (action === 'continue') { await openScratch(prompt.promptId); return; }
				await flushPrompt();
				const record = await pads.read(prompt.promptId);
				if (!record || record.summary.archivedAt || record.summary.completed) throw new Error('This pad is no longer in Recents.');
				if (action === 'summarise') return summarisePrompt(record.summary.title, record.value);
				const binding = owner();
				const active = binding.projectId === SCRATCH_SCOPE && binding.promptId === prompt.promptId;
				const checkpoint = serializedDraft();
				if (active && (checkpoint !== lastSaved || binding.revision !== record.revision)) throw new Error('The Scratch pad changed. Review it before archiving.');
				await pads.archive(prompt.promptId, record.revision);
				if (active && owner() === binding) {
					++actionGeneration;
					const laterEdits = serializedDraft() !== checkpoint ? workflow.exportCheckpoint() : null;
					await replaceBoundDraft(undefined, laterEdits);
					if (laterEdits) { lastSaved = ''; await flushPrompt(); }
				}
				listings.fire();
				return;
			}
			if (!projectViews) return;
			if (action === 'archive') { await archivePrompt(prompt, true); return; }
			if (action === 'continue') {
				const request = startSwitch();
				const {generation} = request;
				if (promptBinding && await flushOrResolveConflict() !== 'ready') return;
				const record = await projectViews.readWorkingPrompt(prompt);
				if (!record) throw new Error('This draft is no longer in Recents.');
				if (generation !== actionGeneration) return;
				if (promptBinding?.projectId === prompt.projectId && promptBinding.promptId === prompt.promptId && promptBinding.revision === record.revision) {
					await openPage('draft');
				} else await openBoundPrompt(prompt.projectId, prompt.promptId, request, record.revision);
				return;
			}
			const record = await projectViews.readWorkingPrompt(prompt);
			if (!record) throw new Error('This draft is no longer in Recents.');
			return summarisePrompt(record.summary.title, record.value);
		},
		saveAgentReadyCopy,
	});
	editor.setDraftSession(sessionKey());
	if (projectViews) editor.showPage('home');

	async function openScratch(id?: string) {
		const request = startSwitch();
		const target = id ?? context.workspaceState.get<string>(LAST_SCRATCH_KEY);
		if (!promptBinding && (target === scratch.promptId || !id && (!target || scratch.revision > 0 || serializedDraft() !== lastSaved))) {
			await openPage('draft', undefined, !!id);
			return;
		}
		const record = target ? await pads.read(target) : undefined;
		if (id && (!record || record.summary.archivedAt || record.summary.completed)) throw new Error('This pad is no longer in Recents.');
		const available = record && !record.summary.archivedAt && isPromptValue(record.value) ? record : undefined;
		const pad = target && available ? {projectId: SCRATCH_SCOPE, promptId: target, revision: available.revision} : newPad();
		const checkpoint = available && isPromptValue(available.value) ? available.value.checkpoint : null;
		if (await switchDraft(request, undefined, checkpoint, pad)) {
			await context.workspaceState.update(LAST_SCRATCH_KEY, pad.promptId);
			if (request.generation === actionGeneration) await openPage('draft', undefined, !!id);
		}
	}

	const openBoundPrompt = async (projectId: string, promptId: string, request: ReturnType<typeof startSwitch>, recentRevision?: number) => {
		const expectedGeneration = request.generation;
		if (!projectViews || expectedGeneration !== actionGeneration || !await projectViews.verifyOwningProject(projectId) || expectedGeneration !== actionGeneration) return;
		const record = await projectViews.readPrompt(projectId, promptId);
		if (expectedGeneration !== actionGeneration || !record || !isPromptValue(record.value)) return;
		if (record.summary.archivedAt) throw new Error('Restore this archived prompt before opening it.');
		if (recentRevision !== undefined && record.revision !== recentRevision) throw new Error('The saved draft changed. Refresh Recents and open it again.');
		const current = promptBinding;
		const samePrompt = current?.projectId === projectId && current.promptId === promptId;
		const beforeTouch = samePrompt ? serializedDraft() : undefined;
		if (samePrompt && beforeTouch !== lastSaved) return;
		// Touch before binding so payload and revision always come from one authoritative read.
		const selected = record.recovered ? record : await projectViews.touchPrompt(projectId, promptId, record.revision);
		if (!selected || !isPromptValue(selected.value)) return;
		if (samePrompt && promptBinding === current) {
			// A touch changes only access time. Advance our revision only if we owned
			// its exact predecessor. A concurrent writer's checkpoint still needs loading.
			if (current.revision === record.revision) current.revision = selected.revision;
			if (beforeTouch !== serializedDraft() || current.revision > selected.revision) return;
		}
		if (!await switchDraft(request, {projectId, promptId, revision: selected.revision}, selected.value.checkpoint ?? null)) return;
		await context.workspaceState.update('dwi.projectContext.activeProject', projectId);
		if (expectedGeneration === actionGeneration) await openPage('draft', undefined, recentRevision !== undefined);
	};
	const archivePrompt = async (prompt: PromptRef, fromRecents = false) => {
		if (!projectViews) return;
		const {projectId, promptId} = prompt;
		const binding = promptBinding?.projectId === projectId && promptBinding.promptId === promptId ? promptBinding : undefined;
		if (binding && (await flushOrResolveConflict() !== 'ready' || binding !== promptBinding)) return;
		const working = fromRecents ? await projectViews.readWorkingPrompt(prompt) : undefined;
		if (fromRecents && !working) throw new Error('This draft is no longer in Recents.');
		if (binding && (binding !== promptBinding || serializedDraft() !== lastSaved)) return;
		const archivedCheckpoint = lastSaved;
		await projectViews.archivePrompt(projectId, promptId, binding?.revision ?? working?.revision);
		if (binding && promptBinding === binding) {
			++actionGeneration;
			if (serializedDraft() !== archivedCheckpoint) {
				// The archive already committed. Keep edits accepted during its write in Scratch.
				scratch = newPad();
				lastSaved = '';
				await persistBinding();
				await flushPrompt();
				await openPage('draft');
				void vscode.window.showInformationMessage('The prompt was archived. Your later edits are open in Scratch.');
			} else {
				await replaceBoundDraft();
				if (!fromRecents) await openPage('draft');
			}
		}
	};
	const createProjectPrompt = async (projectId: string, title: string, checkpoint?: unknown) => {
		if (!projectViews) throw new Error('Project Context is not active.');
		const record = await projectViews.createPrompt(projectId, title, checkpoint);
		if (record.key.kind !== 'prompt') throw new Error('Created record is not a prompt.');
		return {projectId, promptId: record.key.promptId, revision: record.revision};
	};
	const reconcile = async () => { if (projectViews) await projectViews.refresh(); };
	const subscriptions: vscode.Disposable[] = [editor, listings, ...(projectChanges ? [projectChanges] : []),
		{dispose: () => { clearTimeout(saveTimer); workflowSubscription(); workflow.cancel(); }},
		vscode.workspace.onDidChangeConfiguration(event => { if (event.affectsConfiguration('dwiNov')) { prefs = readPanelSettings(configuration()); editor.refreshSettings(); } }),
		vscode.window.registerWebviewViewProvider('dwiNov.home', editor, {webviewOptions: {retainContextWhenHidden: true}}),
		vscode.window.registerTreeDataProvider('dwiNov.settings', {
			getChildren: (node?: string) => node ? settingsSections.filter(section => section.group === node).map(section => section.name) : settingsGroups,
			getTreeItem(node: string) { const parent = settingsGroups.some(group => group === node); const item = new vscode.TreeItem(node, parent ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None); item.id = 'settings.' + node; if (!parent) item.command = {command: 'dwiNov.settingPage', title: node, arguments: [node]}; return item; }
		}),
		vscode.commands.registerCommand('dwiNov.settingPage', async (node: unknown) => { const section = settingsSections.find(item => item.name === node); if (section) await openPage(section.page); }),
		vscode.commands.registerCommand('dwiNov.returnToDraft', async () => { ++actionGeneration; await safe('Could not return to draft', async () => { await openPage('draft'); }); }),
		vscode.commands.registerCommand('dwiNov.scratch', () => safe('Could not open Scratch', () => openScratch())),
		vscode.commands.registerCommand('dwiNov.newScratch', () => safe('Could not start a new Scratch pad', async () => {
			const request = startSwitch(), pad = newPad();
			if (await switchDraft(request, undefined, null, pad)) {
				await context.workspaceState.update(LAST_SCRATCH_KEY, pad.promptId);
				if (request.generation === actionGeneration) await openPage('draft');
			}
		})),
		vscode.commands.registerCommand('dwiNov.contextSources', () => openContextSources(workflow)),
		vscode.commands.registerCommand('dwiNov.searchSettings', async () => { const selection = await vscode.window.showQuickPick(searchableSettings, {placeHolder: 'Filter settings by key or path', matchOnDescription: true}); if (selection) await openPage(selection.page, selection.key); }),
		vscode.commands.registerCommand('dwiNov.open', async () => { ++actionGeneration; await safe('Could not open Dwi Nov', async () => { await openPage('draft'); }); }),
		vscode.commands.registerCommand('dwiNov.openHome', async () => { ++actionGeneration; await safe('Could not open Home', async () => { await openPage('home'); }); }),
		vscode.commands.registerCommand('dwiNov.openRecents', async () => { ++actionGeneration; await safe('Could not open Recents', async () => { await openPage('recents'); }); }),
	];
	if (projectViews) subscriptions.push(
		vscode.workspace.onDidChangeWorkspaceFolders(() => {
			const generation = ++actionGeneration;
			const binding = promptBinding;
			void safe('Could not reconcile project context', async () => {
				await reconcile();
				if (!binding || binding !== promptBinding || generation !== actionGeneration) return;
				const available = await projectViews.verifyOwningProject(binding.projectId);
				if (binding !== promptBinding || generation !== actionGeneration) return;
				if (available) {
					await flushPrompt();
					return;
				}
				const result = await flushOrResolveConflict();
				if (result !== 'ready' || binding !== promptBinding || generation !== actionGeneration) return;
				if (JSON.stringify(workflow.exportCheckpoint()) !== lastSaved) return;
				await replaceBoundDraft();
			});
		}),
		vscode.workspace.onDidGrantWorkspaceTrust(() => { void reconcile(); }),
		vscode.window.onDidChangeActiveTextEditor(() => { void reconcile(); }),
		vscode.window.registerWebviewViewProvider('dwi.projectContext',
			new (require('./project-context/setup-view') as typeof import('./project-context/setup-view')).ProjectSetupView(context.extensionUri, projectViews, openPage)),
		vscode.window.registerTreeDataProvider('dwi.projectPrompts', projectViews),
		vscode.commands.registerCommand('dwi.projectContext.openPrompts', async () => {
			await vscode.commands.executeCommand('setContext', 'dwiNov.projectContextOpen', false);
			await vscode.commands.executeCommand('setContext', 'dwiNov.projectPromptsOpen', true);
			await vscode.commands.executeCommand('dwi.projectPrompts.focus');
		}),
		vscode.commands.registerCommand('dwi.projectContext.initialize', () => safe('Could not initialize project', async () => { const id = await projectViews.initialize(); if (id) await openProjectContext(); return id; })),
		vscode.commands.registerCommand('dwi.projectContext.new', () => safe('Could not create prompt', async () => {
			const request = startSwitch();
			const {generation} = request; if (promptBinding && await flushOrResolveConflict() !== 'ready') return;
			const projectId = await projectViews.getActiveProjectId(); if (!projectId || generation !== actionGeneration || !await projectViews.verifyOwningProject(projectId)) return;
			const title = await vscode.window.showInputBox({prompt: 'Prompt title', validateInput: value => value.trim() ? undefined : 'Enter a title'}); if (!title?.trim() || generation !== actionGeneration) return;
			const value = await createProjectPrompt(projectId, title.trim()); if (generation !== actionGeneration) return;
			if (await switchDraft(request, value)) await openPage('draft');
		})),
		vscode.commands.registerCommand('dwi.projectContext.open', (node?: {projectId?: string; promptId?: string; recent?: boolean}) => safe('Could not open prompt', async () => {
			const request = startSwitch();
			const {generation} = request; if (promptBinding && await flushOrResolveConflict() !== 'ready') return;
			const projectId = node?.projectId ?? await projectViews.getActiveProjectId(); if (!projectId || generation !== actionGeneration || !await projectViews.verifyOwningProject(projectId)) return;
			let promptId = node?.promptId;
			if (!promptId) {
				const prompts = await projectViews.listRecentPrompts(projectId);
				const choices = prompts.flatMap(item => item.key.kind === 'prompt' ?
					[{label: item.summary.title, description: item.summary.updatedAt, id: item.key.promptId}] : []);
				if (generation !== actionGeneration) return;
				promptId = (await vscode.window.showQuickPick(choices))?.id;
			}
			if (!promptId || generation !== actionGeneration) return;
			if ((node?.recent || !node?.promptId) && !await projectViews.isRecentPromptVisible(projectId, promptId)) {
				throw new Error('This prompt is no longer in Recent prompts.');
			}
			await openBoundPrompt(projectId, promptId, request);
		})),
		vscode.commands.registerCommand('dwi.projectContext.copyFinal', (node?: PromptRef) => safe('Could not copy agent-ready prompt', async () => {
			if (!node?.projectId || !node.promptId) return;
			if (promptBinding?.projectId === node.projectId && promptBinding.promptId === node.promptId) await flushPrompt();
			const text = await projectViews.readAgentReadyCopy(node.projectId, node.promptId);
			if (!text) throw new Error('Finalize the current wording before copying an agent-ready prompt.');
			await vscode.env.clipboard.writeText(text);
		})),
		vscode.commands.registerCommand('dwi.projectContext.archive', (node?: PromptRef) => safe('Could not archive prompt', async () => {
			if (node?.projectId && node.promptId) await archivePrompt(node);
		})),
		...(['complete', 'restore'] as const).map(action => vscode.commands.registerCommand(`dwi.projectContext.${action}`, (node: {projectId?: string; promptId?: string}) => safe(`Could not ${action} prompt`, async () => {
			if (!node?.projectId || !node.promptId) return;
			const binding = promptBinding?.projectId === node.projectId && promptBinding.promptId === node.promptId ? promptBinding : undefined;
			if (binding && (await flushOrResolveConflict() !== 'ready' || promptBinding !== binding)) return;
			const revision = binding?.revision;
			const updated = action === 'complete'
				? await projectViews.markComplete(node.projectId, node.promptId, revision)
				: await projectViews.restorePrompt(node.projectId, node.promptId, revision);
			if (binding && promptBinding === binding && binding.revision === revision) binding.revision = updated.revision;
		}))),
		vscode.commands.registerCommand('dwi.projectContext.select', (node?: {projectId?: string}) => safe('Could not select project', async () => {
			const previous = promptBinding;
			const projectId = await projectViews.selectProject(node?.projectId);
			if (!projectId) return;
			if (!node) await openProjectContext();
			else if (previous && previous.projectId !== projectId && !promptBinding) await openPage('draft');
			return projectId;
		})),
		vscode.commands.registerCommand('dwi.projectContext.reviewContext', () => safe('Could not review project context', async () => projectViews.reviewContext())),
		vscode.commands.registerCommand('dwi.projectContext.hideRecent', (node?: {projectId?: string; promptId?: string}) => node?.projectId ? safe('Could not hide recent prompt', async () => projectViews.hideRecent(node.projectId!, node.promptId)) : undefined),
		vscode.commands.registerCommand('dwi.projectContext.attachApprovedSources', () => safe('Could not attach project context', async () => {
			const binding = promptBinding;
			if (!binding) return;
			const branch = workflow.branchId, prior = workflow.contextSources;
			const sources = await projectViews.attachApprovedSources(binding.projectId);
			if (sources.length && promptBinding === binding) workflow.setContextSources(branch, prior, [...sources]);
		}))
	);
	context.subscriptions.push(...subscriptions);
	const disposeReview = async () => { if (closing) return closing; closing = (async () => { await flushPrompt().catch(error => safe('Could not save prompt before closing', async () => { throw error; })); workflowSubscription(); await logs.close(); })(); return closing; };
	closeReview = disposeReview;
	if (projectViews && !options.headless) void safe('Could not open Home', () => openPage('home'));
	return {
		getSnapshot: () => workflow.snapshot,
		subscribe: (listener: () => void) => workflow.subscribe(listener),
		dispatch: (command: ReviewCommand) => workflow.dispatch(command),
		readWorkerInput: (version: number) => workflow.readWorkerInput(version),
		readReplacementAttempts: () => workflow.readReplacementAttempts(),
		projectContext: projectViews,
		createProjectPrompt,
	};
}

export async function deactivate() { await closeReview?.(); projectContext?.dispose(); await model?.dispose(); }
