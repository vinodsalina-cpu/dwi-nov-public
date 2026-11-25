import * as vscode from 'vscode';
import { join } from 'node:path';
import { ModernBertWorker } from './core/modernbert-rewrite';
import { mapWithModernBert } from './core/prompt-mapping';
import { ReviewWorkflow, localServices, type ReviewServices, type ReviewCommand } from './core/review-workflow';
import { ReviewLogs } from './core/review-logs';
import { ReviewEditor, type PanelPage } from './review-editor';
import { openContextSources } from './context-source-menu';
import { readPanelSettings, searchableSettings, settingsGroups, settingsSections, type SettingKey } from './review-settings';
import type { ProjectContextViews } from './project-context/vscode-views';
import { isPromptValue } from './project-context/contracts';
import { summarisePrompt, type PromptRef } from './project-context/prompt-recents';

type PromptBinding = { projectId: string; promptId: string; revision: number };
type PersistedBinding = { projectId: string; promptId: string };
const BINDING_KEY = 'dwi.projectContext.activePrompt';
let model: ModernBertWorker | undefined;
let projectContext: vscode.Disposable | undefined;
let closeReview: (() => Promise<void>) | undefined;

export function activate(context: vscode.ExtensionContext) {
	const bundle = join(context.extensionUri.fsPath, 'out', 'modernbert');
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
	const projectViews = options.projectContext ? new (require('./project-context/vscode-views') as typeof import('./project-context/vscode-views')).ProjectContextViews(context) : undefined;
	projectContext = projectViews;
	const configuration = () => vscode.workspace.getConfiguration('dwiNov');
	let prefs = readPanelSettings(configuration());
	const logs = new ReviewLogs(context.globalStorageUri.fsPath, () => prefs.source === 'markov', message => { void vscode.window.showWarningMessage(message); });
	let promptBinding: PromptBinding | undefined;
	const workflow = new ReviewWorkflow(services.stepThree && projectViews ? {...services, stepThree: {
		...services.stepThree,
		async context(wording, signal) {
			const projectId = promptBinding?.projectId;
			if (!projectId) return {relevance: 'unknown', references: []};
			try { return await projectViews.clarificationEvidence(projectId, wording, signal); }
			catch { signal.throwIfAborted(); return {relevance: 'unknown', references: []}; }
		}
	}} : services, logs.capture);
	let hydrating = false, actionGeneration = 0, lastSaved = '';
	let saveTimer: NodeJS.Timeout | undefined, saveTail: Promise<void> = Promise.resolve(), closing: Promise<void> | undefined;
	let queuedSave: string | undefined;
	let pendingSave: Promise<void> | undefined;
	const safe = async <T,>(label: string, operation: () => Promise<T>): Promise<T | undefined> => {
		try { return await operation(); } catch (error) { await vscode.window.showErrorMessage(`${label}: ${String(error)}`); return undefined; }
	};
	const changed = () => { if (!hydrating && promptBinding) { clearTimeout(saveTimer); saveTimer = setTimeout(() => { void safe('Could not save prompt', saveNow); }, 500); } };
	const saveNow = async () => {
		if (!promptBinding) return;
		const binding = promptBinding, checkpoint = workflow.exportCheckpoint(), serialized = JSON.stringify(checkpoint);
		if (serialized === lastSaved) return;
		if (serialized === queuedSave) return pendingSave;
		queuedSave = serialized;
		const task = saveTail.then(async () => {
			if (promptBinding?.projectId !== binding.projectId || promptBinding.promptId !== binding.promptId) return;
			const saved = await projectViews!.savePrompt(binding.projectId, binding.promptId, checkpoint, binding.revision);
			if (promptBinding?.projectId === binding.projectId && promptBinding.promptId === binding.promptId && promptBinding.revision === binding.revision) promptBinding.revision = saved.revision;
			lastSaved = serialized;
		});
		saveTail = task.catch(() => undefined);
		pendingSave = task;
		try { await task; } finally { if (queuedSave === serialized) { queuedSave = undefined; pendingSave = undefined; } }
	};
	const flushPrompt = async () => { clearTimeout(saveTimer); saveTimer = undefined; await saveTail; if (promptBinding) await saveNow(); };
	const saveAgentReadyCopy = async (text: string, version: number): Promise<boolean> => {
		const binding = promptBinding;
		if (!binding || !projectViews) return false;
		const checkpoint = workflow.exportCheckpoint();
		const task = saveTail.then(async () => {
			if (promptBinding !== binding || workflow.snapshot.version !== version) throw new Error('The draft changed. Review it before copying again.');
			const saved = await projectViews.savePrompt(binding.projectId, binding.promptId, checkpoint, binding.revision, text);
			binding.revision = saved.revision;
			if (promptBinding === binding) lastSaved = JSON.stringify(checkpoint);
		});
		saveTail = task.catch(() => undefined);
		await task;
		return true;
	};
	const flushOrResolveConflict = async (): Promise<'ready' | 'stay' | 'scratch'> => {
		try { await flushPrompt(); return 'ready'; } catch (error) {
			const choice = await vscode.window.showErrorMessage(`This prompt changed elsewhere. Your current text is still available.`, 'Keep Editing', 'Copy to Scratch', 'Save as New Project Prompt');
			if (choice === 'Keep Editing' || !choice) return 'stay';
			if (choice === 'Copy to Scratch') { workflow.cancel(); await persistBinding(); lastSaved = ''; return 'scratch'; }
			if (choice === 'Save as New Project Prompt' && promptBinding && projectViews) {
				const title = await vscode.window.showInputBox({prompt: 'Title for the new project prompt'});
				if (!title?.trim()) return 'stay';
				const checkpoint = workflow.exportCheckpoint();
				const created = await createProjectPrompt(promptBinding.projectId, title.trim(), checkpoint);
				await persistBinding(created); lastSaved = JSON.stringify(checkpoint); return 'ready';
			}
			return 'stay';
		}
	};
	const persistBinding = async (binding?: PromptBinding) => {
		promptBinding = binding;
		const value: PersistedBinding | undefined = binding && {projectId: binding.projectId, promptId: binding.promptId};
		await context.workspaceState.update(BINDING_KEY, value);
	};
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
		async homeState() {
			await flushPrompt().catch(() => undefined);
			return await projectViews?.homeState() ?? {canStartProjectPrompt: false};
		},
		async homeAction(action, lastPrompt) {
			if (action === 'recents') { await openPage('recents'); return; }
			if (action === 'scratch') {
				if (promptBinding) await vscode.commands.executeCommand('dwiNov.scratch');
				else await openPage('draft');
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
			await flushPrompt().catch(() => undefined);
			return await projectViews?.workingPrompts() ?? [];
		},
		async recentAction(action, prompt) {
			if (!projectViews) return;
			if (action === 'archive') { await archivePrompt(prompt, true); return; }
			if (action === 'continue') {
				const generation = ++actionGeneration;
				if (promptBinding && await flushOrResolveConflict() !== 'ready') return;
				const record = await projectViews.readWorkingPrompt(prompt);
				if (!record) throw new Error('This draft is no longer in Recents.');
				if (generation !== actionGeneration) return;
				if (promptBinding?.projectId === prompt.projectId && promptBinding.promptId === prompt.promptId && promptBinding.revision === record.revision) {
					await openPage('draft');
				} else await openBoundPrompt(prompt.projectId, prompt.promptId, generation, record.revision);
				return;
			}
			const record = await projectViews.readWorkingPrompt(prompt);
			if (!record) throw new Error('This draft is no longer in Recents.');
			return summarisePrompt(record.summary.title, record.value);
		},
		saveAgentReadyCopy,
	});
	if (projectViews) editor.showPage('home');
	const openBoundPrompt = async (projectId: string, promptId: string, expectedGeneration: number, recentRevision?: number) => {
		if (!projectViews || expectedGeneration !== actionGeneration || !await projectViews.verifyOwningProject(projectId) || expectedGeneration !== actionGeneration) return;
		const record = await projectViews.readPrompt(projectId, promptId);
		if (expectedGeneration !== actionGeneration || !record || !isPromptValue(record.value)) return;
		if (recentRevision !== undefined && record.revision !== recentRevision) throw new Error('The saved draft changed. Refresh Recents and open it again.');
		// Touch before binding so payload and revision always come from one authoritative read.
		const selected = record.recovered ? record : await projectViews.touchPrompt(projectId, promptId, recentRevision);
		if (expectedGeneration !== actionGeneration || !selected || !isPromptValue(selected.value)) return;
		const checkpoint = selected.value.checkpoint ?? null;
		hydrating = true;
		if (checkpoint !== null && !workflow.restoreCheckpoint(checkpoint)) { hydrating = false; throw new Error('Saved prompt is invalid; the current review was kept.'); }
		if (checkpoint === null) workflow.restoreCheckpoint(null);
		await persistBinding({projectId, promptId, revision: selected.revision});
		lastSaved = JSON.stringify(workflow.exportCheckpoint()); hydrating = false;
		await context.workspaceState.update('dwi.projectContext.activeProject', projectId);
		await openPage('draft', undefined, recentRevision !== undefined);
	};
	const archivePrompt = async (prompt: PromptRef, fromRecents = false) => {
		if (!projectViews) return;
		const {projectId, promptId} = prompt;
		const binding = promptBinding?.projectId === projectId && promptBinding.promptId === promptId ? promptBinding : undefined;
		if (binding && await flushOrResolveConflict() !== 'ready') return;
		const working = fromRecents ? await projectViews.readWorkingPrompt(prompt) : undefined;
		if (fromRecents && !working) throw new Error('This draft is no longer in Recents.');
		await projectViews.archivePrompt(projectId, promptId, binding?.revision ?? working?.revision);
		if (binding && promptBinding === binding) {
			++actionGeneration;
			workflow.cancel(); await persistBinding();
			hydrating = true; workflow.restoreCheckpoint(null); hydrating = false; lastSaved = '';
			if (!fromRecents) await openPage('draft');
		}
	};
	const createProjectPrompt = async (projectId: string, title: string, checkpoint?: unknown) => {
		if (!projectViews) throw new Error('Project Context is not active.');
		const record = await projectViews.createPrompt(projectId, title, checkpoint);
		if (record.key.kind !== 'prompt') throw new Error('Created record is not a prompt.');
		return {projectId, promptId: record.key.promptId, revision: record.revision};
	};
	const reconcile = async () => { if (projectViews) await projectViews.refresh(); };
	const subscriptions: vscode.Disposable[] = [editor,
		{dispose: () => { clearTimeout(saveTimer); workflowSubscription(); workflow.cancel(); }},
		vscode.workspace.onDidChangeConfiguration(event => { if (event.affectsConfiguration('dwiNov')) { prefs = readPanelSettings(configuration()); editor.refreshSettings(); } }),
		vscode.window.registerWebviewViewProvider('dwiNov.home', editor, {webviewOptions: {retainContextWhenHidden: true}}),
		vscode.window.registerTreeDataProvider('dwiNov.settings', {
			getChildren: (node?: string) => node ? settingsSections.filter(section => section.group === node).map(section => section.name) : settingsGroups,
			getTreeItem(node: string) { const parent = settingsGroups.some(group => group === node); const item = new vscode.TreeItem(node, parent ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None); item.id = 'settings.' + node; if (!parent) item.command = {command: 'dwiNov.settingPage', title: node, arguments: [node]}; return item; }
		}),
		vscode.commands.registerCommand('dwiNov.settingPage', async (node: unknown) => { const section = settingsSections.find(item => item.name === node); if (section) await openPage(section.page); }),
		vscode.commands.registerCommand('dwiNov.returnToDraft', async () => { ++actionGeneration; await safe('Could not return to draft', async () => { await openPage('draft'); }); }),
		vscode.commands.registerCommand('dwiNov.scratch', async () => { ++actionGeneration; await safe('Could not switch to Scratch', async () => { const result = await flushOrResolveConflict(); if (result === 'stay') return; if (result === 'scratch') { await openPage('draft'); return; } workflow.cancel(); hydrating = true; workflow.restoreCheckpoint(null); hydrating = false; await persistBinding(); lastSaved = ''; await openPage('draft'); }); }),
		vscode.commands.registerCommand('dwiNov.contextSources', () => openContextSources(workflow)),
		vscode.commands.registerCommand('dwiNov.searchSettings', async () => { const selection = await vscode.window.showQuickPick(searchableSettings, {placeHolder: 'Filter settings by key or path', matchOnDescription: true}); if (selection) await openPage(selection.page, selection.key); }),
		vscode.commands.registerCommand('dwiNov.open', async () => { ++actionGeneration; await safe('Could not open Dwi Nov', async () => { await openPage('draft'); }); }),
		vscode.commands.registerCommand('dwiNov.openHome', async () => { ++actionGeneration; await safe('Could not open Home', async () => { await openPage('home'); }); }),
		vscode.commands.registerCommand('dwiNov.openRecents', async () => { ++actionGeneration; await safe('Could not open Recents', async () => { await openPage('recents'); }); }),
	];
	if (projectViews) subscriptions.push(
		vscode.workspace.onDidChangeWorkspaceFolders(() => { const gen = ++actionGeneration; void safe('Could not reconcile project context', async () => { await reconcile(); if (promptBinding && !await projectViews.verifyOwningProject(promptBinding.projectId) && gen === actionGeneration) { const result = await flushOrResolveConflict(); workflow.cancel(); await persistBinding(); if (result !== 'scratch') { hydrating = true; workflow.restoreCheckpoint(null); hydrating = false; } } }); }),
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
		vscode.commands.registerCommand('dwi.projectContext.initialize', () => safe('Could not initialize project', async () => { const id = await projectViews.initialize(); if (id) { await context.workspaceState.update('dwi.projectContext.activeProject', id); await openProjectContext(); } return id; })),
		vscode.commands.registerCommand('dwi.projectContext.new', () => safe('Could not create prompt', async () => {
			const generation = ++actionGeneration; if (promptBinding && await flushOrResolveConflict() !== 'ready') return;
			const projectId = await projectViews.getActiveProjectId(); if (!projectId || generation !== actionGeneration || !await projectViews.verifyOwningProject(projectId)) return;
			const title = await vscode.window.showInputBox({prompt: 'Prompt title', validateInput: value => value.trim() ? undefined : 'Enter a title'}); if (!title?.trim() || generation !== actionGeneration) return;
			const value = await createProjectPrompt(projectId, title.trim()); if (generation !== actionGeneration) return;
			await persistBinding(value); lastSaved = ''; hydrating = true; workflow.restoreCheckpoint(null); hydrating = false; await openPage('draft');
		})),
		vscode.commands.registerCommand('dwi.projectContext.open', (node?: {projectId?: string; promptId?: string; recent?: boolean}) => safe('Could not open prompt', async () => {
			const generation = ++actionGeneration; if (promptBinding && await flushOrResolveConflict() !== 'ready') return;
			const projectId = node?.projectId ?? await projectViews.getActiveProjectId(); if (!projectId || generation !== actionGeneration || !await projectViews.verifyOwningProject(projectId)) return;
			let promptId = node?.promptId;
			if (!promptId) {
				const prompts = await (node?.recent ? projectViews.listRecentPrompts(projectId) : projectViews.listPrompts(projectId));
				const choices = prompts.flatMap(item => item.key.kind === 'prompt' ?
					[{label: item.summary.title, description: item.summary.updatedAt, id: item.key.promptId}] : []);
				if (generation !== actionGeneration) return;
				promptId = (await vscode.window.showQuickPick(choices))?.id;
			}
			if (!promptId || generation !== actionGeneration) return;
			await openBoundPrompt(projectId, promptId, generation);
		})),
		vscode.commands.registerCommand('dwi.projectContext.copyFinal', (node?: PromptRef) => safe('Could not copy agent-ready prompt', async () => {
			if (!node?.projectId || !node.promptId) return;
			const record = await projectViews.readPrompt(node.projectId, node.promptId);
			if (!record || !isPromptValue(record.value) || !record.value.agentReadyCopy) throw new Error('This prompt has no saved agent-ready copy.');
			await vscode.env.clipboard.writeText(record.value.agentReadyCopy);
		})),
		vscode.commands.registerCommand('dwi.projectContext.archive', (node?: PromptRef) => safe('Could not archive prompt', async () => {
			if (node?.projectId && node.promptId) await archivePrompt(node);
		})),
		...(['complete', 'restore'] as const).map(action => vscode.commands.registerCommand(`dwi.projectContext.${action}`, (node: {projectId?: string; promptId?: string}) => safe(`Could not ${action} prompt`, async () => {
			if (!node?.projectId || !node.promptId) return;
			const active = promptBinding?.projectId === node.projectId && promptBinding.promptId === node.promptId;
			if (active && await flushOrResolveConflict() !== 'ready') return;
			const updated = await (action === 'complete' ? projectViews.markComplete(node.projectId, node.promptId) : projectViews.restorePrompt(node.projectId, node.promptId));
			if (active && promptBinding?.projectId === node.projectId && promptBinding.promptId === node.promptId) promptBinding.revision = updated.revision;
		}))),
		vscode.commands.registerCommand('dwi.projectContext.select', (node?: {projectId?: string}) => safe('Could not select project', async () => {
			const generation = ++actionGeneration; if (promptBinding && await flushOrResolveConflict() !== 'ready') return;
			const projectId = await projectViews.selectProject(node?.projectId); if (!projectId || generation !== actionGeneration) return;
			await context.workspaceState.update('dwi.projectContext.activeProject', projectId);
			if (promptBinding && promptBinding.projectId !== projectId) { workflow.cancel(); await persistBinding(); hydrating = true; workflow.restoreCheckpoint(null); hydrating = false; lastSaved = ''; await openPage('draft'); }
			if (!node) await openProjectContext();
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
