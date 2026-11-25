import * as vscode from 'vscode';
import { createHash, randomUUID } from 'node:crypto';
import { open, readFile, realpath } from 'node:fs/promises';
import { basename, isAbsolute, relative, resolve } from 'node:path';
import { contextCharacterLimit, type ContextSource as RuntimeContextSource } from '../core/context-sources';
import { FileRecordStore } from './file-store';
import { isApprovedContext, isProjectValue, isPromptValue, type ApprovedContext, type ContextSource, type ProjectCandidate, type ProjectValue, type RecordHeader, type StoredRecord } from './contracts';
import { ProjectContextService } from './service';
import { savedDraftText, type PromptRef, type RecentPrompt } from './prompt-recents';
import { readProjectSetup, type ProjectSetup, type ProjectSetupSource } from './setup';
import { containsPath, hasObviousSecret, isSecretLikePath, resolveWorkspaceRoots, unsupportedStorageReason, type WorkspaceRoot } from './vscode-host';

type Node = { label: string; description?: string; command?: string; projectId?: string; promptId?: string; contextValue?: string; collapsible?: vscode.TreeItemCollapsibleState };
type ProjectEntry = { id: string; record: StoredRecord; value: ProjectValue; root?: WorkspaceRoot; available: boolean };
export type PendingContextReview = {
	id: string;
	projectId: string;
	revision: number;
	basisFingerprint?: string;
	sources: ContextSource[];
};
export type HomePrompt = RecentPrompt & { project: string };
export type HomeState = { canStartProjectPrompt: boolean; lastPrompt?: HomePrompt };
const RECENT_PROJECTS_KEY = 'dwi.projectContext.hiddenProjects';
const MAX_HIDDEN_PROJECTS = 100;
const RECENT_LIMIT = 20;
const RECENT_PROMPTS_KEY = 'dwi.projectContext.recentPrompts';

/** Host adapter: the file store and service remain the sole owners of durable records. */
export class ProjectContextViews implements vscode.TreeDataProvider<Node>, vscode.Disposable {
	private readonly changed = new vscode.EventEmitter<Node | undefined>();
	readonly onDidChangeTreeData = this.changed.event;
	private roots: readonly WorkspaceRoot[] = [];
	private entries: ProjectEntry[] = [];
	private selectedProjectId?: string;
	private readonly subscriptions: vscode.Disposable[] = [];
	private readonly store: FileRecordStore;
	private readonly gitApi?: { repositories: readonly { rootUri: vscode.Uri; state: { onDidChange: vscode.Event<void>; HEAD?: { name?: string; commit?: string } } }[]; onDidOpenRepository?: vscode.Event<{ rootUri: vscode.Uri; state: { onDidChange: vscode.Event<void>; HEAD?: { name?: string; commit?: string } } }> };
	private refreshing?: Promise<void>;

	constructor(private readonly context: vscode.ExtensionContext) {
		this.store = new FileRecordStore(vscode.Uri.joinPath(context.globalStorageUri, 'project-context').fsPath);
		this.gitApi = this.getGitApi();
		this.subscriptions.push(
			vscode.workspace.onDidChangeWorkspaceFolders(() => { void this.refresh(); }),
			vscode.workspace.onDidGrantWorkspaceTrust(() => { void this.refresh(); }),
			vscode.workspace.onDidChangeConfiguration(event => { if (event.affectsConfiguration('dwiNov.projectContext')) void this.refresh(); }),
			vscode.window.onDidChangeActiveTextEditor(() => { this.changed.fire(undefined); }),
		);
		this.watchGit();
		void this.refresh();
	}

	private getGitApi() {
		try {
			const extension = vscode.extensions.getExtension<{ getAPI(version: 1): unknown }>('vscode.git');
			if (!extension) return undefined;
			const api = extension.exports?.getAPI(1) as ProjectContextViews['gitApi'];
			return api;
		} catch { return undefined; }
	}

	private watchGit() {
		const bind = (repository: { rootUri: vscode.Uri; state: { onDidChange: vscode.Event<void> } }) => {
			this.subscriptions.push(repository.state.onDidChange(() => { void this.refresh(); }));
		};
		for (const repository of this.gitApi?.repositories ?? []) bind(repository);
		if (this.gitApi?.onDidOpenRepository) this.subscriptions.push(this.gitApi.onDidOpenRepository(bind));
	}

	private service(root: WorkspaceRoot, validateContextSource?: (source: ContextSource) => Promise<boolean>): ProjectContextService {
		return new ProjectContextService(this.store, {
			checkout: { checkoutKey: root.identity, rootLabel: root.name, rootLocator: root.canonicalPath },
			promptId: () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`,
			now: () => new Date().toISOString(),
			validateContextSource: validateContextSource ?? (() => false),
		});
	}

	private trusted(): void { if (!vscode.workspace.isTrusted) throw new Error('Trust this workspace before using project context.'); }
	private localUri(uri: vscode.Uri): void { const reason = unsupportedStorageReason(uri); if (reason) throw new Error(reason); }

	async refresh(notify = true): Promise<void> {
		if (this.refreshing) return this.refreshing;
		this.refreshing = (async () => {
			this.roots = await resolveWorkspaceRoots();
			const rootsByIdentity = new Map(this.roots.map(root => [root.identity, root]));
			const projects = await this.store.list('project');
			const entries: ProjectEntry[] = [];
			for (const header of projects) {
				if (header.key.kind !== 'project') continue;
				const record = await this.store.read(header.key).catch(() => undefined);
				if (!record || !isProjectValue(record.value)) continue;
				const value = record.value;
				const root = rootsByIdentity.get(value.checkoutKey);
				entries.push({ id: header.key.projectId, record, value, root, available: !!root && root.canonicalPath === value.rootLocator });
			}
			this.entries = entries;
			if (this.selectedProjectId && !entries.some(entry => entry.id === this.selectedProjectId)) this.selectedProjectId = undefined;
			if (notify) this.changed.fire(undefined);
		})().finally(() => { this.refreshing = undefined; });
		return this.refreshing;
	}

	getTreeItem(node: Node): vscode.TreeItem {
		const collapsible = node.collapsible ?? (node.contextValue === 'projectContext.project' || node.contextValue === 'projectContext.group' || node.contextValue?.endsWith('Group') ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None);
		const item = new vscode.TreeItem(node.label, collapsible);
		item.description = node.description;
		item.contextValue = node.contextValue;
		if (node.command) item.command = { command: node.command, title: node.label, arguments: [{ projectId: node.projectId, promptId: node.promptId }] };
		return item;
	}

	async getChildren(node?: Node): Promise<Node[]> {
		await this.refresh(false);
		if (node?.contextValue === 'projectContext.home') return this.homeEntries();
		if (node?.contextValue === 'projectContext.group') return this.recentProjectNodes();
		if (node?.contextValue === 'projectContext.recentPrompts') return this.recentPromptNodes(this.context.globalState.get(RECENT_PROMPTS_KEY, []));
		if (node?.projectId && ['projectContext.projectRecents', 'projectContext.activeGroup', 'projectContext.completedGroup', 'projectContext.archivedGroup'].includes(node.contextValue ?? '')) return this.projectChildren(node.projectId, node.contextValue);
		if (node) return [];
		const activeProjectId = await this.getActiveProjectId();
		if (activeProjectId) return [
			{ label: 'Home', contextValue: 'projectContext.home', collapsible: vscode.TreeItemCollapsibleState.Collapsed },
			...await this.projectChildren(activeProjectId),
		];
		return this.homeEntries();
	}

	private homeEntries(): Node[] {
		const hidden = new Set(this.context.globalState.get<string[]>(RECENT_PROJECTS_KEY, []));
		const recent = [...this.entries].filter(entry => !hidden.has(entry.id)).sort((a, b) => b.record.summary.updatedAt.localeCompare(a.record.summary.updatedAt)).slice(0, RECENT_LIMIT);
		const recentPrompts = this.context.globalState.get<Array<{ projectId: string; promptId: string; title: string; updatedAt: string }>>(RECENT_PROMPTS_KEY, []).slice(0, RECENT_LIMIT);
		const nodes: Node[] = [{ label: 'Initialize Project', command: 'dwi.projectContext.initialize', contextValue: 'projectContext.initialize' }];
		if (recent.length) nodes.push({ label: 'Recent projects', contextValue: 'projectContext.group', collapsible: vscode.TreeItemCollapsibleState.Collapsed });
		if (recentPrompts.length) nodes.push({ label: 'Recent prompts', contextValue: 'projectContext.recentPrompts', collapsible: vscode.TreeItemCollapsibleState.Collapsed });
		return nodes;
	}

	private recentProjectNodes(): Node[] {
		const hidden = new Set(this.context.globalState.get<string[]>(RECENT_PROJECTS_KEY, []));
		return [...this.entries].filter(entry => !hidden.has(entry.id)).sort((a, b) => b.record.summary.updatedAt.localeCompare(a.record.summary.updatedAt)).slice(0, RECENT_LIMIT).map(entry => ({ label: entry.record.summary.title, description: entry.available ? entry.root?.canonicalPath : 'Unavailable checkout', command: 'dwi.projectContext.select', projectId: entry.id, contextValue: 'projectContext.project', collapsible: vscode.TreeItemCollapsibleState.None }));
	}

	private recentPromptNodes(items: Array<{ projectId: string; promptId: string; title: string; updatedAt: string }>): Node[] {
		return items.slice(0, RECENT_LIMIT).map(prompt => ({ label: prompt.title, description: `${prompt.updatedAt} · ${this.entries.some(entry => entry.id === prompt.projectId && entry.available) ? 'Available' : 'Unavailable project'}`, command: 'dwi.projectContext.open', projectId: prompt.projectId, promptId: prompt.promptId, contextValue: 'projectContext.prompt' }));
	}

	private async projectChildren(projectId: string, group?: string): Promise<Node[]> {
		const entry = this.entries.find(item => item.id === projectId);
		if (!entry || !entry.available || !entry.root) return [{ label: 'Checkout unavailable', description: entry?.value.rootLocator, contextValue: 'projectContext.unavailable' }];
		const service = this.service(entry.root);
		const prompts = await service.listPrompts(projectId, true);
		if (group === 'projectContext.activeGroup' || group === 'projectContext.completedGroup' || group === 'projectContext.archivedGroup') {
			const selected = group === 'projectContext.activeGroup' ? prompts.filter(item => !item.summary.archivedAt && !item.summary.completed) : group === 'projectContext.completedGroup' ? prompts.filter(item => !item.summary.archivedAt && item.summary.completed) : prompts.filter(item => !!item.summary.archivedAt);
			return selected.map(item => ({ label: item.summary.title, description: item.summary.updatedAt, command: 'dwi.projectContext.open', projectId, promptId: item.key.kind === 'prompt' ? item.key.promptId : undefined,
				contextValue: item.summary.completed ? 'projectContext.completedPrompt' : 'projectContext.prompt' }));
		}
		const nodes: Node[] = [{ label: entry.record.summary.title, description: this.checkoutDescription(entry.root), contextValue: 'projectContext.projectHeader', collapsible: vscode.TreeItemCollapsibleState.None },
			{ label: 'New prompt', command: 'dwi.projectContext.new', projectId, contextValue: 'projectContext.new' },
			{ label: 'Review context…', command: 'dwi.projectContext.reviewContext', projectId, contextValue: 'projectContext.reviewContext' },
			{ label: 'Hide recent project', command: 'dwi.projectContext.hideRecent', projectId, contextValue: 'projectContext.hideProject' },
			{ label: 'Attach approved sources', command: 'dwi.projectContext.attachApprovedSources', projectId, contextValue: 'projectContext.attachSources' }];
		const active = prompts.filter(item => !item.summary.archivedAt && !item.summary.completed);
		const completed = prompts.filter(item => !item.summary.archivedAt && item.summary.completed);
		const archived = prompts.filter(item => !!item.summary.archivedAt);
		const recents = await service.listRecents(projectId, RECENT_LIMIT);
		const promptNode = (item: RecordHeader): Node => ({ label: item.summary.title, description: item.summary.updatedAt, command: 'dwi.projectContext.open', projectId, promptId: item.key.kind === 'prompt' ? item.key.promptId : undefined, contextValue: 'projectContext.prompt' });
		if (group === 'projectContext.projectRecents') return recents.map(promptNode);
		nodes.push({ label: `Recent (${recents.length})`, contextValue: 'projectContext.projectRecents', projectId, collapsible: vscode.TreeItemCollapsibleState.Collapsed });
		if (group !== 'projectContext.activeGroup') nodes.push({ label: `Active (${active.length})`, contextValue: 'projectContext.activeGroup', projectId, collapsible: vscode.TreeItemCollapsibleState.Collapsed });
		if (group !== 'projectContext.completedGroup') nodes.push({ label: `Completed (${completed.length})`, contextValue: 'projectContext.completedGroup', projectId, collapsible: vscode.TreeItemCollapsibleState.Collapsed });
		if (group !== 'projectContext.archivedGroup') nodes.push({ label: `Archived (${archived.length})`, contextValue: 'projectContext.archivedGroup', projectId, collapsible: vscode.TreeItemCollapsibleState.Collapsed });
		return nodes;
	}

	private checkoutDescription(root: WorkspaceRoot): string {
		return `${root.canonicalPath}${this.gitApi ? ' · Git state monitored' : ''}`;
	}

	async initialize(): Promise<string | undefined> {
		this.trusted();
		const roots = await resolveWorkspaceRoots();
		if (!roots.length) { await vscode.window.showWarningMessage('Add an available local file folder before initializing a project.'); return; }
		const choice = await vscode.window.showQuickPick(roots.map(root => ({ label: root.name, description: root.canonicalPath, root })), { placeHolder: 'Choose a project folder' });
		if (!choice) return;
		const name = await vscode.window.showInputBox({ prompt: 'Project display name', value: choice.root.name, validateInput: value => value.trim() ? undefined : 'Enter a project name' });
		if (!name?.trim()) return;
		return this.initializeRoot(choice.root.uri, name.trim());
	}

	async initializeRoot(uri: vscode.Uri, name: string): Promise<string | undefined> {
		this.trusted(); this.localUri(uri);
		const roots = await resolveWorkspaceRoots();
		const canonical = await realpath(uri.fsPath);
		const root = roots.find(item => item.canonicalPath === canonical);
		if (!root) throw new Error('Choose a current, available workspace folder.');
		if (!name.trim()) throw new Error('Enter a project name.');
		const identity = { ...root, name: name.trim() };
		const record = await this.service(identity).initialize();
		this.selectedProjectId = record.key.projectId;
		await this.context.globalState.update(RECENT_PROJECTS_KEY, (this.context.globalState.get<string[]>(RECENT_PROJECTS_KEY, [])).filter(id => id !== record.key.projectId));
		await this.refresh();
		return record.key.projectId;
	}

	async getActiveProjectId(): Promise<string | undefined> {
		await this.refresh(false);
		const candidates: ProjectCandidate[] = this.entries.filter(entry => entry.available && entry.root).map(entry => ({
			projectId: entry.id, location: entry.root!.canonicalPath, active: true,
			containsActiveResource: !!vscode.window.activeTextEditor && vscode.window.activeTextEditor.document.uri.scheme === 'file' && containsPath(entry.root!.canonicalPath, vscode.window.activeTextEditor.document.uri.fsPath),
			depth: entry.root!.canonicalPath.split(/[\\/]/).filter(Boolean).length,
		}));
		const storedSelection = this.context.workspaceState.get<string>('dwi.projectContext.activeProject');
		const requested = storedSelection ?? this.selectedProjectId;
		const explicit = requested && candidates.some(candidate => candidate.projectId === requested) ? requested : undefined;
		const resolver = new ProjectContextService(this.store, { checkout: { checkoutKey: '', rootLabel: '', rootLocator: '' }, promptId: () => '', now: () => new Date().toISOString(), validateContextSource: () => false });
		const result = await resolver.prepareScope({ explicitProjectId: explicit, activeResource: vscode.window.activeTextEditor?.document.uri.fsPath, candidates });
		return result.kind === 'resolved' ? result.projectId : undefined;
	}

	async selectProject(projectId?: string): Promise<string | undefined> {
		this.trusted(); await this.refresh();
		if (!projectId) {
			const choice = await vscode.window.showQuickPick(this.entries.map(entry => ({ label: entry.record.summary.title, description: entry.available ? entry.value.rootLocator : `Unavailable · ${entry.value.rootLocator}`, id: entry.id, unavailable: !entry.available })), { placeHolder: 'Select a registered project' });
			projectId = choice?.id;
		}
		if (!projectId) return;
		const entry = this.entries.find(item => item.id === projectId);
		if (!entry) throw new Error('Project is not registered.');
		if (!entry.available || !entry.root || !await this.verifyOwningProject(projectId)) throw new Error('The registered checkout is unavailable or has changed identity.');
		this.selectedProjectId = projectId; await this.context.workspaceState.update('dwi.projectContext.activeProject', projectId); this.changed.fire(undefined); return projectId;
	}

	async verifyOwningProject(projectId: string): Promise<boolean> {
		await this.refresh();
		const entry = this.entries.find(item => item.id === projectId);
		if (!entry || !entry.available || !entry.root || entry.root.canonicalPath !== entry.value.rootLocator) return false;
		try { return await realpath(entry.value.rootLocator) === entry.root.canonicalPath && entry.root.identity === entry.value.checkoutKey; } catch { return false; }
	}

	async setupState(projectId?: string) {
		const trusted = vscode.workspace.isTrusted;
		if (!trusted) return { trusted, roots: [], projects: [] };
		const active = projectId ?? await this.getActiveProjectId();
		if (projectId) await this.refresh(false);
		const entry = this.entries.find(item => item.id === active && item.available);
		const roots = this.roots
			.filter((root, index, all) => all.findIndex(item => item.identity === root.identity) === index)
			.filter(root => !this.entries.some(item => item.value.checkoutKey === root.identity))
			.map(root => ({ id: root.identity, label: root.name, path: root.canonicalPath }));
		const projects = this.entries.map(item => ({ id: item.id, name: item.record.summary.title, path: item.value.rootLocator, available: item.available }));
		if (!entry?.root) return { trusted, roots, projects };
		const setup = readProjectSetup(entry.value.draftSetup);
		const context = entry.value.approvedContext;
		const basisMatches = context && await this.checkoutFingerprint(entry.root) === context.basisFingerprint;
		const approved = await Promise.all((context?.sources ?? []).map(async source => ({
			reference: source.reference, capturedAt: source.capturedAt, sourceId: source.sourceId,
			approved: !!basisMatches && await this.validateSetupExcerpt(entry.root!, setup, source),
		})));
		return { trusted, roots, projects, project: {
			id: entry.id, name: entry.record.summary.title, path: entry.root.canonicalPath,
			revision: entry.record.revision, setup, approved, canEdit: !entry.record.recovered,
		} };
	}

	async linkProject(rootId: string, name: string) {
		const root = (await resolveWorkspaceRoots()).find(item => item.identity === rootId);
		if (!root || !name.trim() || name.length > 300 || hasObviousSecret(name)) throw new Error('Choose a workspace folder and enter a project name.');
		const id = await this.initializeRoot(root.uri, name);
		if (id) await this.selectProject(id);
	}

	async updateSetup(projectId: string, revision: number, operation: unknown) {
		const { service } = await this.requireProject(projectId, true);
		if (operation && typeof operation === 'object') {
			const input = operation as { source?: object; brief?: object };
			for (const fields of [input.source, input.brief]) {
				if (!fields || typeof fields !== 'object') continue;
				const values: unknown[] = Object.values(fields).flat();
				if (values.some(value => typeof value === 'string' && hasObviousSecret(value))) {
					throw new Error('Remove credentials from the project context before saving.');
				}
			}
		}
		await service.updateProjectSetup(projectId, revision, operation);
		await this.refresh();
	}

	async sourceDetailsTitle(projectId: string, sourceId: string): Promise<string> {
		const { entry } = await this.requireProject(projectId, true);
		const source = readProjectSetup(entry.value.draftSetup).sources.find(item => item.id === sourceId);
		if (!source) throw new Error('This source was removed from the project.');
		return source.title;
	}

	async generateBriefDraft(projectId: string) {
		const { entry } = await this.requireProject(projectId, true);
		if (entry.record.recovered) throw new Error('The recovered project is read-only.');
		const setup = readProjectSetup(entry.value.draftSetup);
		const root = entry.root!;
		const approved = entry.value.approvedContext;
		const notes: string[] = [];
		const evidenceRefs: string[] = [];
		if (approved && await this.checkoutFingerprint(root) === approved.basisFingerprint) {
			for (const source of this.orderedExcerpts(setup, approved.sources)) {
				if (!await this.validateSetupExcerpt(root, setup, source)) continue;
				const excerpt = source.excerpt.trim().replace(/\s+/gu, ' ');
				if (!excerpt) continue;
				const label = source.reference.length > 200 ? source.reference.slice(0, 199) + '…' : source.reference;
				notes.push(`- ${label}: ${excerpt.length > 360 ? excerpt.slice(0, 359) + '…' : excerpt}`);
				if (source.reference.length <= 200) evidenceRefs.push(source.reference);
				if (notes.length === 8) break;
			}
		}
		const summary = `Project: ${entry.record.summary.title}\nCheckout: ${root.name}`;
		return {
			revision: entry.record.revision,
			brief: {
				content: notes.length ? `${summary}\n\nApproved source notes\n${notes.join('\n')}` : summary,
				unknowns: notes.length ? [] : ['Project objective and constraints'],
				evidenceRefs,
			},
		};
	}

	async startSetupReview(projectId: string, sourceId?: string): Promise<PendingContextReview | undefined> {
		const { entry, service } = await this.requireProject(projectId, true);
		const root = entry.root!;
		const project = await service.readProject(projectId);
		if (!project || project.recovered || !isProjectValue(project.value)) throw new Error('Project context is unavailable for editing.');
		const basisFingerprint = await this.checkoutFingerprint(root);
		let sources: ContextSource[];
		if (sourceId) {
			const source = readProjectSetup(project.value.draftSetup).sources.find(item => item.id === sourceId);
			if (!source?.enabled || source.category === 'connectors' || source.category === 'mcp') throw new Error('Choose an enabled local source.');
			if (source.content.trim()) {
				if (hasObviousSecret(source.content)) throw new Error('Sensitive source content cannot be reviewed.');
				sources = [{ reference: source.title, excerpt: source.content, capturedAt: new Date().toISOString(), fingerprint: this.inlineFingerprint(source), sourceId, kind: 'inline' }];
			} else {
				const uri = this.sourceFile(root, source.reference);
				if (!uri) throw new Error('Use a file path relative to the project checkout.');
				sources = (await this.readSelectedSources(root, [uri])).map(item => ({ ...item, sourceId }));
			}
		} else {
			const files = await vscode.window.showOpenDialog({
				canSelectFiles: true, canSelectFolders: false, canSelectMany: true,
				defaultUri: root.uri, openLabel: 'Review excerpts',
			});
			if (!files?.length) return;
			sources = await this.readSelectedSources(root, files);
		}
		return { id: randomUUID(), projectId, revision: project.revision, basisFingerprint, sources };
	}

	async approveSetupReview(pending: PendingContextReview) {
		const { projectId, revision, basisFingerprint } = pending;
		const { entry } = await this.requireProject(projectId, true);
		const root = entry.root!;
		const project = entry.record;
		if (project.revision !== revision) throw new Error('Project context changed. Open a new excerpt review.');
		const basis = await this.checkoutFingerprint(root);
		if (basis !== basisFingerprint) throw new Error('Checkout changed during review. Open a new excerpt review.');
		const setup = readProjectSetup(entry.value.draftSetup);
		const validate = (source: ContextSource) => this.validateSetupExcerpt(root, setup, source);
		const current = entry.value.approvedContext;
		const sources = [...pending.sources];
		if (current && current.basisFingerprint === basis) {
			for (const source of current.sources) {
				if (sources.some(next => next.sourceId && next.sourceId === source.sourceId ||
					!next.kind && !source.kind && next.reference === source.reference)) continue;
				if (await validate(source)) sources.push(source);
			}
		}
		if (sources.reduce((total, source) => total + source.excerpt.length, 0) > contextCharacterLimit || sources.length > 100) {
			throw new Error('These excerpts exceed the project context limit.');
		}
		const approveExact = async (source: ContextSource) => {
			if (!await validate(source)) throw new Error(`“${source.reference}” changed or is unavailable. Cancel and review the source again.`);
			return true;
		};
		await this.service(root, approveExact).approveContext(projectId, {
			consentedAt: new Date().toISOString(), basisFingerprint: basis, sources,
		}, basis, revision);
		await this.refresh();
	}

	async setupSnapshot(projectId: string, revision?: number) {
		const { entry } = await this.requireProject(projectId, true);
		const byConsent = new Map<string, { revision: number; snapshot: ApprovedContext }>();
		for (const record of await this.store.readProjectRevisions(projectId, 100)) {
			if (!isProjectValue(record.value) || record.value.checkoutKey !== entry.value.checkoutKey) continue;
			const snapshot = record.value.approvedContext;
			if (snapshot) byConsent.set(snapshot.consentedAt, { revision: record.revision, snapshot });
		}
		const snapshots = [...byConsent.values()];
		const choice = revision === undefined ? snapshots[0] : snapshots.find(item => item.revision === revision);
		if (revision !== undefined && !choice) throw new Error('This excerpt version is unavailable.');
		return {
			revision: choice?.revision,
			sources: (choice?.snapshot.sources ?? []).map(({ reference, excerpt }) => ({ reference, excerpt })),
			versions: snapshots.map(item => ({ revision: item.revision, consentedAt: item.snapshot.consentedAt })),
		};
	}

	private sourceFile(root: WorkspaceRoot, reference: string): vscode.Uri | undefined {
		if (!reference || isAbsolute(reference) || /^[A-Za-z]:|^\\/u.test(reference) ||
			reference.split(/[\\/]/u).some(segment => segment === '..')) return undefined;
		return vscode.Uri.file(resolve(root.canonicalPath, reference));
	}

	private inlineFingerprint(source: ProjectSetupSource) {
		return createHash('sha256').update(JSON.stringify([source.category, source.title, source.content, source.reference])).digest('hex');
	}

	private async validateSetupExcerpt(root: WorkspaceRoot, setup: ProjectSetup, source: ContextSource): Promise<boolean> {
		if (!source.sourceId) return this.validateApprovedSource(root, source);
		const configured = setup.sources.find(item => item.id === source.sourceId);
		if (!configured?.enabled || configured.category === 'connectors' || configured.category === 'mcp') return false;
		if (source.kind === 'inline') {
			return !hasObviousSecret(configured.content) && source.excerpt === configured.content &&
				source.reference === configured.title && source.fingerprint === this.inlineFingerprint(configured);
		}
		const uri = this.sourceFile(root, configured.reference);
		if (!uri || configured.content.trim()) return false;
		try { await this.validateSelectedSource(root, uri, source); return true; }
		catch { return false; }
	}

	private orderedExcerpts(setup: ProjectSetup, sources: ContextSource[]): ContextSource[] {
		const order = new Map(setup.sources.map((source, index) => [source.id, index]));
		return [...sources].sort((a, b) =>
			(order.get(a.sourceId ?? '') ?? order.size) - (order.get(b.sourceId ?? '') ?? order.size));
	}

	private async requireProject(projectId: string, mutate = false): Promise<{ entry: ProjectEntry; service: ProjectContextService }> {
		if (mutate) this.trusted();
		await this.refresh();
		const entry = this.entries.find(item => item.id === projectId);
		if (!entry) throw new Error('Project is not registered.');
		if (!await this.verifyOwningProject(projectId)) throw new Error('The owning checkout is unavailable or has changed identity.');
		return { entry, service: this.service(entry.root!) };
	}

	async createPrompt(projectId: string, title: string, checkpoint?: unknown) { const { service } = await this.requireProject(projectId, true); const value = await service.createPrompt(projectId, title, checkpoint); await this.refresh(); return value; }
	async readPrompt(projectId: string, promptId: string) { const { service } = await this.requireProject(projectId); return service.readPrompt(projectId, promptId); }
	private async promptCandidates(unfinished: boolean) {
		if (!vscode.workspace.isTrusted) return {available: [], candidates: []};
		await this.refresh(false);
		const available = this.entries.filter(entry => entry.available && entry.root);
		const candidates = (await Promise.all(available.map(async entry => {
			const headers = await this.store.list('prompt', entry.id);
			return headers.filter(header => header.key.kind === 'prompt' && !header.summary.archivedAt && (!unfinished || !header.summary.completed) &&
				!entry.value.hiddenPromptIds.includes(header.key.promptId)).map(header => ({entry, header}));
		}))).flat().sort((a, b) => b.header.summary.updatedAt.localeCompare(a.header.summary.updatedAt));
		return {available, candidates};
	}

	async homeState(): Promise<HomeState> {
		const {available, candidates} = await this.promptCandidates(false);
		for (const {entry, header} of candidates) {
			if (header.key.kind !== 'prompt') continue;
			const record = await this.store.read(header.key).catch(() => undefined);
			if (!record || record.summary.archivedAt || !savedDraftText(record.value)) continue;
			return {canStartProjectPrompt: true, lastPrompt: {
				projectId: entry.id, promptId: header.key.promptId, title: record.summary.title,
				project: entry.record.summary.title, updatedAt: record.summary.updatedAt,
			}};
		}
		return {canStartProjectPrompt: available.length > 0};
	}

	async workingPrompts(): Promise<RecentPrompt[]> {
		const {candidates} = await this.promptCandidates(true);
		const prompts: RecentPrompt[] = [];
		for (const {entry, header} of candidates) {
			if (header.key.kind !== 'prompt') continue;
			const record = await this.store.read(header.key).catch(() => undefined);
			if (!record || record.summary.archivedAt || record.summary.completed || !savedDraftText(record.value)) continue;
			prompts.push({projectId: entry.id, promptId: header.key.promptId, title: record.summary.title, updatedAt: record.summary.updatedAt});
		}
		return prompts.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.promptId.localeCompare(b.promptId));
	}

	async readWorkingPrompt({projectId, promptId}: PromptRef) {
		const {entry, service} = await this.requireProject(projectId, true);
		if (entry.value.hiddenPromptIds.includes(promptId)) return undefined;
		const record = await service.readPrompt(projectId, promptId);
		return record && !record.summary.archivedAt && !record.summary.completed && savedDraftText(record.value) ? record : undefined;
	}

	async canOpenHomePrompt(prompt: HomePrompt): Promise<boolean> {
		const {entry, service} = await this.requireProject(prompt.projectId, true);
		if (entry.value.hiddenPromptIds.includes(prompt.promptId)) return false;
		const record = await service.readPrompt(prompt.projectId, prompt.promptId);
		return !!record && !record.summary.archivedAt && !!savedDraftText(record.value);
	}
	private async rememberPrompt(projectId: string, promptId: string): Promise<void> {
		const entry = this.entries.find(item => item.id === projectId);
		const record = entry?.root ? await this.service(entry.root).readPrompt(projectId, promptId).catch(() => undefined) : undefined;
		const current = this.context.globalState.get<Array<{ projectId: string; promptId: string; title: string; updatedAt: string }>>(RECENT_PROMPTS_KEY, []);
		const title = record?.summary.title ?? current.find(item => item.projectId === projectId && item.promptId === promptId)?.title;
		if (title) await this.context.globalState.update(RECENT_PROMPTS_KEY, [{ projectId, promptId, title, updatedAt: new Date().toISOString() }, ...current.filter(item => item.projectId !== projectId || item.promptId !== promptId)].slice(0, RECENT_LIMIT));
	}
	async touchPrompt(projectId: string, promptId: string, expectedRevision?: number) { const { service } = await this.requireProject(projectId, true); const value = await service.touchPrompt(projectId, promptId, expectedRevision); await this.rememberPrompt(projectId, promptId); await this.refresh(); return value; }
	async listPrompts(projectId: string) { const { service } = await this.requireProject(projectId); return service.listPrompts(projectId); }
	async listRecentPrompts(projectId: string) { const { service } = await this.requireProject(projectId); return service.listRecents(projectId, RECENT_LIMIT); }
	async markComplete(projectId: string, promptId: string) { const { service } = await this.requireProject(projectId, true); const value = await service.markComplete(projectId, promptId); await this.refresh(); return value; }
	async archivePrompt(projectId: string, promptId: string, expectedRevision?: number) { const { service } = await this.requireProject(projectId, true); const value = await service.archivePrompt(projectId, promptId, expectedRevision); await this.refresh(); return value; }
	async restorePrompt(projectId: string, promptId: string) { const { service } = await this.requireProject(projectId, true); const value = await service.restorePrompt(projectId, promptId); await this.refresh(); return value; }
	async readProject(projectId: string) { const { service } = await this.requireProject(projectId); return service.readProject(projectId); }
	async savePrompt(projectId: string, promptId: string, checkpoint: unknown, expectedRevision: number, agentReadyCopy?: string) {
		const {service} = await this.requireProject(projectId, true);
		const value = await service.savePrompt(projectId, promptId, checkpoint, undefined, expectedRevision, agentReadyCopy);
		this.changed.fire(undefined);
		return value;
	}
	async hideRecent(projectId: string, promptId?: string): Promise<void> {
		this.trusted();
		if (promptId) { const { service } = await this.requireProject(projectId, true); await service.hideRecent(projectId, promptId); }
		else { await this.requireProject(projectId, true); const hidden = this.context.globalState.get<string[]>(RECENT_PROJECTS_KEY, []); await this.context.globalState.update(RECENT_PROJECTS_KEY, [...new Set([...hidden, projectId])].slice(-MAX_HIDDEN_PROJECTS)); }
		await this.refresh();
	}

	async reviewContext(projectId?: string): Promise<void> {
		this.trusted();
		const selected = await this.selectProject(projectId);
		if (!selected) return;
		const pending = await this.startSetupReview(selected);
		if (!pending) return;
		const preview = pending.sources.map(source => `--- ${source.reference} ---\n${source.excerpt}`).join('\n\n');
		const previewContent = `Review these exact excerpts before approval.\n\n${preview}`;
		const document = await vscode.workspace.openTextDocument({ language: 'markdown', content: previewContent });
		const editor = await vscode.window.showTextDocument(document, { preview: false });
		const answer = await vscode.window.showInformationMessage('Review the open excerpts, then approve them for reviewer context.', 'Approve');
		if (answer !== 'Approve') return;
		if (document.isClosed || editor.document !== document || document.getText() !== previewContent) throw new Error('Approval preview changed or closed; review the excerpts again.');
		await this.approveSetupReview(pending);
	}

	private async readSelectedSources(root: WorkspaceRoot, files: readonly vscode.Uri[]): Promise<ContextSource[]> {
		const sources: ContextSource[] = []; let total = 0;
		for (const uri of files) {
			this.localUri(uri);
			if (isSecretLikePath(uri.fsPath)) throw new Error(`Sensitive file name rejected: ${basename(uri.fsPath)}`);
			const resolved = await realpath(uri.fsPath);
			if (!containsPath(root.canonicalPath, resolved)) throw new Error(`Selection is outside the project: ${basename(uri.fsPath)}`);
			const reference = relative(root.canonicalPath, resolved);
			if (isSecretLikePath(reference)) throw new Error(`Sensitive file name rejected: ${reference}`);
			const bytes = await this.readBoundedFile(resolved, contextCharacterLimit * 4, reference);
			const excerpt = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
			if (excerpt.length > contextCharacterLimit || hasObviousSecret(excerpt)) throw new Error(`Sensitive or oversized content rejected: ${reference}`);
			total += excerpt.length; if (total > contextCharacterLimit) throw new Error('Selected excerpts exceed the context limit. Select fewer files.');
			sources.push({ reference, excerpt, capturedAt: new Date().toISOString(), fingerprint: createHash('sha256').update(bytes).digest('hex') });
		}
		return sources;
	}

	private async validateSelectedSource(root: WorkspaceRoot, uri: vscode.Uri, source: ContextSource): Promise<void> {
		const resolved = await realpath(uri.fsPath);
		if (isSecretLikePath(uri.fsPath) || isSecretLikePath(source.reference) || isSecretLikePath(resolved) || !containsPath(root.canonicalPath, resolved) || relative(root.canonicalPath, resolved) !== source.reference) throw new Error(`Source identity changed or became sensitive: ${source.reference}`);
		const bytes = await this.readBoundedFile(resolved, contextCharacterLimit * 4, source.reference);
		const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
		if (text.length > contextCharacterLimit || hasObviousSecret(text) || createHash('sha256').update(bytes).digest('hex') !== source.fingerprint || text !== source.excerpt) throw new Error(`Source changed during approval: ${source.reference}`);
	}

	private async validateApprovedSource(root: WorkspaceRoot, source: ContextSource): Promise<boolean> {
		if (!source.reference || isAbsolute(source.reference) || source.reference.split(/[\\/]/).includes('..') || isSecretLikePath(source.reference)) return false;
		try {
			await this.validateSelectedSource(root, vscode.Uri.file(resolve(root.canonicalPath, source.reference)), source);
			return true;
		} catch { return false; }
	}

	private async readBoundedFile(path: string, maximumBytes: number, reference: string): Promise<Buffer> {
		const handle = await open(path, 'r');
		try {
			const info = await handle.stat();
			if (!info.isFile() || info.size > maximumBytes) throw new Error(`File is not a bounded regular file: ${reference}`);
			const buffer = Buffer.alloc(maximumBytes + 1);
			const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
			if (bytesRead > maximumBytes) throw new Error(`File is not a bounded regular file: ${reference}`);
			return buffer.subarray(0, bytesRead);
		} finally { await handle.close(); }
	}

	async attachApprovedSources(projectId: string): Promise<readonly RuntimeContextSource[]> {
		this.trusted();
		const { entry, service } = await this.requireProject(projectId);
		const project = await service.readProject(projectId);
		if (!project || !isProjectValue(project.value) || !project.value.approvedContext || !isApprovedContext(project.value.approvedContext)) return [];
		const approved = project.value.approvedContext;
		const currentBasis = await this.checkoutFingerprint(entry.root!);
		if (currentBasis !== approved.basisFingerprint) {
			await vscode.window.showInformationMessage('Approved context basis is now stale; review sources before attaching.');
			return [];
		}
		const setup = readProjectSetup(project.value.draftSetup);
		const categories = new Map(setup.sources.map(source => [source.id, source.category]));
		const stale: string[] = [];
		const valid: RuntimeContextSource[] = [];
		for (const source of this.orderedExcerpts(setup, approved.sources)) {
			if (!await this.validateSetupExcerpt(entry.root!, setup, source)) { stale.push(source.reference); continue; }
			const category = categories.get(source.sourceId ?? '') ?? 'documents';
			if (category === 'connectors' || category === 'mcp') continue;
			const id = `${projectId}:${source.sourceId ?? createHash('sha256').update(source.reference).digest('hex')}`;
			valid.push({ id, label: source.reference, category, content: source.excerpt });
		}
		if (stale.length) await vscode.window.showWarningMessage(`Some approved context sources changed or were disabled and were not attached: ${stale.join(', ')}`);
		return valid;
	}

	async clarificationEvidence(projectId: string, wording: string, signal: AbortSignal): Promise<import('../core/step-three').ApprovedEvidence> {
		const unknown = {relevance: 'unknown' as const, references: []};
		if (!vscode.workspace.isTrusted) return unknown;
		const {entry, service} = await this.requireProject(projectId, true);
		const project = await service.readProject(projectId);
		const value = project && isProjectValue(project.value) ? project.value : undefined;
		const approved = value?.approvedContext;
		const root = entry.root;
		if (!root || !approved?.sources.length || await this.checkoutFingerprint(root) !== approved.basisFingerprint) return unknown;
		const words = wording.toLowerCase().match(/[a-z][\w./-]{3,}/gu) ?? [];
		const common = new Set(['please', 'would', 'should', 'could', 'after', 'before', 'change', 'there', 'which', 'when',
			'that', 'this', 'thing', 'update', 'have', 'with', 'from', 'your', 'make', 'what', 'file', 'using', 'component', 'specific']);
		const terms = [...new Set(words.filter(word => !common.has(word)))].slice(0, 24);
		if (!terms.length) return unknown;
		let complete = approved.sources.length <= 100;
		const references: import('../core/step-three').Reference[] = [];
		const setup = readProjectSetup(value?.draftSetup);
		for (const source of this.orderedExcerpts(setup, approved.sources).slice(0, 100)) {
			signal.throwIfAborted();
			if (!await this.validateSetupExcerpt(root, setup, source)) { complete = false; continue; }
			const path = source.reference.toLowerCase();
			const lines = source.excerpt.split(/\r?\n/u);
			const line = lines.findIndex(value => {
				const tokens = new Set(value.toLowerCase().match(/[a-z][\w./-]{3,}/gu) ?? []);
				return terms.some(term => tokens.has(term));
			});
			if (line < 0 && !terms.some(term => path.split(/[/._-]/u).includes(term) || term === path)) continue;
			const start = Math.max(0, line - 2);
			references.push({ label: `${source.reference}:${Math.max(1, line + 1)}`,
				excerpt: lines.slice(start, Math.max(3, line + 3)).join('\n').slice(0, 2_000) });
			if (references.length === 3) break;
		}
		return { relevance: references.length ? 'match' : complete ? 'none' : 'unknown', references };
	}

	private async checkoutFingerprint(root: WorkspaceRoot): Promise<string | undefined> {
		const matching = this.gitApi?.repositories.find(repository => repository.rootUri.scheme === 'file' && containsPath(root.canonicalPath, repository.rootUri.fsPath));
		if (!matching) return undefined;
		const uri = matching.rootUri;
		try {
			const head = await readFile(resolve(uri.fsPath, '.git', 'HEAD'), 'utf8').catch(() => '');
			const branch = String(matching.state.HEAD?.name ?? '') + '\0' + String(matching.state.HEAD?.commit ?? '');
			return createHash('sha256').update(`${head}\0${branch}`).digest('hex');
		} catch { return undefined; }
	}

	dispose(): void { this.changed.dispose(); for (const subscription of this.subscriptions) subscription.dispose(); }
}
