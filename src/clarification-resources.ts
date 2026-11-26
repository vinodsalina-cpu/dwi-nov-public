import { basename } from 'node:path';
import * as vscode from 'vscode';
import type { ReviewWorkflow } from './core/review-workflow';
import { stepId } from './core/step-id';

/** Owns native file selection and only the read-only tabs opened by clarification. */
export class ClarificationResources {
	private readonly documents = new Map<string, string>();
	private readonly tabs = new Map<string, vscode.Uri>();
	private readonly provider = vscode.workspace.registerTextDocumentContentProvider('dwi-clarification', {
		provideTextDocumentContent: uri => this.documents.get(uri.toString()) ?? '',
	});
	constructor(private readonly workflow: ReviewWorkflow) {}

	async pick(version: unknown, question: unknown, field: unknown) {
		const control = this.workflow.clarificationResource(version, question, field)?.file;
		if (!control) return;
		const selected = await vscode.window.showOpenDialog({canSelectFiles: true, canSelectFolders: false,
			canSelectMany: !!control.multiple, openLabel: 'Choose file', defaultUri: vscode.workspace.workspaceFolders?.[0]?.uri});
		if (!selected?.length) return;
		const files = [];
		for (const uri of selected) {
			if (uri.scheme !== 'file' || !((await vscode.workspace.fs.stat(uri)).type & vscode.FileType.File)) {
				throw new Error('Choose an available local file.');
			}
			files.push({uri: uri.toString(), label: vscode.workspace.getWorkspaceFolder(uri)
				? vscode.workspace.asRelativePath(uri) : basename(uri.fsPath)});
		}
		return this.workflow.registerClarificationFiles(version, question, field, files) ? files : undefined;
	}

	async open(branch: number, version: unknown, question: unknown) {
		const reference = await this.workflow.clarificationReference(version, question);
		if (!reference || typeof question !== 'string' || this.workflow.branchId !== branch) return;
		const key = `${branch}:${question}`;
		const uri = this.tabs.get(key) ?? vscode.Uri.from({scheme: 'dwi-clarification', path: `/${basename(reference.label)}`, query: stepId()});
		this.tabs.set(key, uri);
		this.documents.set(uri.toString(), `${reference.label}\n\n${reference.excerpt}`);
		await vscode.window.showTextDocument(uri, {preview: false});
		if (!this.workflow.clarificationResource(version, question)?.reference) await this.close(branch, question);
	}

	async close(branch: number, question: string) {
		const key = `${branch}:${question}`;
		const uri = this.tabs.get(key);
		if (!uri) return;
		this.tabs.delete(key);
		const identifier = uri.toString();
		const tabs = vscode.window.tabGroups.all.flatMap(group => group.tabs).filter(tab =>
			tab.input instanceof vscode.TabInputText && tab.input.uri.toString() === identifier);
		if (tabs.length) await vscode.window.tabGroups.close(tabs, true);
		this.documents.delete(identifier);
	}

	dispose() {
		for (const [key] of this.tabs) {
			const [branch, question] = key.split(':');
			void this.close(Number(branch), question).catch(() => {});
		}
		this.provider.dispose();
		this.documents.clear();
	}
}
