import * as vscode from 'vscode';
import type { PendingContextReview, ProjectContextViews } from './vscode-views';

type Message = {
	type?: unknown;
	projectId?: unknown;
	root?: unknown;
	name?: unknown;
	revision?: unknown;
	operation?: unknown;
	sourceId?: unknown;
	reviewId?: unknown;
};

export class ProjectSetupView implements vscode.WebviewViewProvider {
	private readonly sessions = new Set<() => void>();
	private readonly sources = new Map<string, vscode.WebviewPanel>();

	constructor(
		private readonly extensionUri: vscode.Uri,
		private readonly projects: ProjectContextViews,
		private readonly navigate: (page: 'home' | 'recents' | 'draft') => Promise<void>,
	) {}

	resolveWebviewView(view: vscode.WebviewView) {
		this.connect(view.webview, () => view.visible, view.onDidChangeVisibility, view.onDidDispose);
	}

	private async openSource(projectId: string, sourceId: string) {
		const key = `${projectId}/${sourceId}`;
		const existing = this.sources.get(key);
		if (existing) { existing.reveal(); return; }
		const title = await this.projects.sourceDetailsTitle(projectId, sourceId);
		const panel = vscode.window.createWebviewPanel('dwi.projectContext.source', title, vscode.ViewColumn.Active, { enableScripts: true });
		this.sources.set(key, panel);
		panel.onDidDispose(() => { this.sources.delete(key); });
		this.connect(panel.webview, () => panel.visible, panel.onDidChangeViewState, panel.onDidDispose, { projectId, sourceId });
	}

	private connect(
		webview: vscode.Webview,
		visible: () => boolean,
		onVisibility: vscode.Event<unknown>,
		onDispose: vscode.Event<void>,
		detail?: { projectId: string; sourceId: string },
	) {
		const media = vscode.Uri.joinPath(this.extensionUri, 'media');
		webview.options = { enableScripts: true, localResourceRoots: [media] };
		const asset = (file: string) => webview.asWebviewUri(vscode.Uri.joinPath(media, file));
		let pending: PendingContextReview | undefined;
		let disposed = false;
		let handling = false;
		let syncGeneration = 0;
		const post = async (message: unknown) => { if (!disposed) await webview.postMessage(message); };
		const sendState = async () => {
			const generation = ++syncGeneration;
			const state = await this.projects.setupState(detail?.projectId);
			if (generation !== syncGeneration) return;
			const review = pending?.projectId === state.project?.id && pending?.revision === state.project?.revision
				? pending : undefined;
			pending = review;
			await post({ type: 'state', state: {
				...state, ...(review ? { review: {
					id: review.id, projectId: review.projectId,
					sources: review.sources.map(({ reference, excerpt }) => ({ reference, excerpt })),
				} } : {}),
			} });
		};
		const report = (error: unknown) => post({ type: 'error', message: error instanceof Error ? error.message : 'Could not load project context.' });
		const refresh = () => { if (visible() && !handling && !disposed) void sendState().catch(report); };
		this.sessions.add(refresh);
		const subscriptions = [
			vscode.workspace.onDidChangeWorkspaceFolders(refresh),
			vscode.workspace.onDidGrantWorkspaceTrust(refresh),
			onVisibility(refresh),
			webview.onDidReceiveMessage(async (value: unknown) => {
				if (!value || typeof value !== 'object' || disposed || handling) return;
				const message = value as Message;
				++syncGeneration;
				handling = true;
				let changed = false;
				try {
					if (message.type === 'home' || message.type === 'recents' || message.type === 'draft') {
						pending = undefined;
						await this.navigate(message.type);
						return;
					}
					if (message.type === 'create' && typeof message.root === 'string' && typeof message.name === 'string') {
						await this.projects.linkProject(message.root, message.name);
						pending = undefined;
						changed = true;
					} else if (message.type === 'select' && typeof message.projectId === 'string') {
						await this.projects.selectProject(message.projectId);
						pending = undefined;
						changed = true;
					} else if (message.type !== 'ready') {
						const id = message.projectId;
						if (typeof id !== 'string' || id !== (detail?.projectId ?? await this.projects.getActiveProjectId())) throw new Error('Choose the current project again.');
						switch (message.type) {
							case 'update':
								if (typeof message.revision !== 'number') throw new Error('Missing project revision.');
								await this.projects.updateSetup(id, message.revision, message.operation);
								pending = undefined;
								changed = true;
								break;
							case 'openSource':
								if (typeof message.sourceId !== 'string') throw new Error('Choose a configured source.');
								await this.openSource(id, message.sourceId);
								break;
							case 'generateBrief':
								await post({ type: 'briefDraft', projectId: id, ...await this.projects.generateBriefDraft(id) });
								return;
							case 'review':
								pending = await this.projects.startSetupReview(id);
								break;
							case 'reviewSource':
								if (typeof message.sourceId !== 'string') throw new Error('Choose a configured source.');
								pending = await this.projects.startSetupReview(id, message.sourceId);
								break;
							case 'approve':
							case 'cancelReview':
								if (!pending || pending.projectId !== id || pending.id !== message.reviewId) throw new Error('Open a new excerpt review.');
								if (message.type === 'approve') {
									await this.projects.approveSetupReview(pending);
									changed = true;
								}
								pending = undefined;
								break;
							case 'preview': {
								const revision = typeof message.revision === 'number' ? message.revision : undefined;
								const snapshot = await this.projects.setupSnapshot(id, revision);
								await post({ type: 'preview', projectId: id, ...snapshot });
								return;
							}
							default:
								return;
						}
					}
					await sendState();
					if (changed) for (const session of this.sessions) session();
				} catch (error) {
					await report(error);
				} finally {
					handling = false;
				}
			}),
		];
		onDispose(() => {
			disposed = true;
			pending = undefined;
			this.sessions.delete(refresh);
			for (const subscription of subscriptions) subscription.dispose();
		});
		webview.html = `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src ${webview.cspSource};">
<title>Project Context</title>
<link rel="stylesheet" href="${asset('project-context.css')}">
<script src="${asset('project-context.js')}" defer></script>
</head><body><main id="project-context"${detail ? ` data-source-id="${detail.sourceId}"` : ''}></main></body></html>`;
	}
}
