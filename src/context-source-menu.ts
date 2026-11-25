import { basename } from 'node:path';
import * as vscode from 'vscode';
import { contextCategories, contextCharacterLimit, type ContextSource } from './core/context-sources';
import type { ReviewWorkflow } from './core/review-workflow';

type Category = keyof typeof contextCategories;
type SourceOption = vscode.QuickPickItem & (
	| { category: Category }
	| { source: ContextSource }
	| { kind: vscode.QuickPickItemKind.Separator }
);
const categories = Object.keys(contextCategories) as Category[];
const referenceOnly = (category: Category) => category === 'connectors' || category === 'mcp';

function labelFor(uri: vscode.Uri) {
	return vscode.workspace.getWorkspaceFolder(uri) ? vscode.workspace.asRelativePath(uri) : basename(uri.fsPath);
}

async function chooseSource(category: Category): Promise<ContextSource | undefined> {
	if (category === 'connectors' || category === 'mcp') {
		const reference = (await vscode.window.showInputBox({
			title: contextCategories[category], prompt: 'Reference name or ID', ignoreFocusOut: true,
			validateInput: input => input.trim().length > 200 ? 'Use a reference up to 200 characters.' : undefined,
		}))?.trim();
		return reference ? { id: reference, label: reference, category } : undefined;
	}
	if (category === 'working-memory') {
		const content = (await vscode.window.showInputBox({
			title: 'Working Memory', prompt: 'Note for this draft', ignoreFocusOut: true,
			validateInput: input => input.length > contextCharacterLimit ? 'This note exceeds the context size limit.' : undefined,
		}))?.trim();
		return content ? { id: content, label: 'Developer note', category, content } : undefined;
	}

	const editor = vscode.window.activeTextEditor;
	const selection = category === 'repository' && editor && !editor.selection.isEmpty &&
		editor.document.uri.scheme === 'file' && vscode.workspace.getWorkspaceFolder(editor.document.uri)
		? {
			uri: editor.document.uri, content: editor.document.getText(editor.selection),
			lines: `:${editor.selection.start.line + 1}–${editor.selection.end.line + 1}`,
		} : undefined;
	if (selection) {
		const choice = await vscode.window.showQuickPick(['Attach editor selection', 'Choose file'], { title: 'Repository' });
		if (!choice) return;
		if (choice === 'Attach editor selection') {
			const { uri, lines, content } = selection;
			return { id: uri.toString() + lines, label: labelFor(uri) + lines, category, content };
		}
	}
	const [uri] = await vscode.window.showOpenDialog({
		title: contextCategories[category], openLabel: 'Attach', canSelectMany: false,
		defaultUri: vscode.workspace.workspaceFolders?.[0]?.uri,
	}) ?? [];
	if (!uri) return;
	if (uri.scheme !== 'file' || (category === 'repository' && !vscode.workspace.getWorkspaceFolder(uri))) {
		throw new Error(category === 'repository' ? 'Choose a local workspace file.' : 'Choose a local text file.');
	}
	const stat = await vscode.workspace.fs.stat(uri);
	if (!(stat.type & vscode.FileType.File) || stat.size > contextCharacterLimit * 4) {
		throw new Error('Choose a text file or a smaller excerpt.');
	}
	const bytes = await vscode.workspace.fs.readFile(uri);
	const content = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
	if (content.includes('\0')) throw new Error('Choose a UTF-8 text file.');
	return { id: uri.toString(), label: labelFor(uri), category, content };
}

async function editContextSources(current: readonly ContextSource[]): Promise<readonly ContextSource[] | undefined> {
	const added: SourceOption[] = categories.map(category => ({
		label: contextCategories[category], category,
		description: referenceOnly(category) ? 'Reference only' : undefined,
	}));
	const existing: SourceOption[] = current.map(source => ({
		label: source.label, description: contextCategories[source.category], source,
		detail: 'content' in source ? 'Attached to this draft' : 'Reference only',
	}));
	const selection = await vscode.window.showQuickPick<SourceOption>([
		{ label: 'Add source', kind: vscode.QuickPickItemKind.Separator }, ...added,
		...(existing.length ? [{ label: 'Current sources', kind: vscode.QuickPickItemKind.Separator } as const, ...existing] : []),
	], { title: 'Context Sources', matchOnDescription: true });
	if (!selection) return;
	if ('source' in selection) {
		const choice = await vscode.window.showQuickPick(['Remove source'], { title: selection.source.label });
		return choice ? current.filter(source => source !== selection.source) : undefined;
	}
	if (!('category' in selection)) return;
	const source = await chooseSource(selection.category);
	if (!source) return;
	if ('content' in source && !source.content.trim()) throw new Error('The selected source has no text.');
	const next = [...current.filter(item => item.category !== source.category || item.id !== source.id), source];
	const characters = next.reduce((total, item) => total + ('content' in item ? item.content.length : 0), 0);
	if (characters > contextCharacterLimit) throw new Error('The draft already has too much context. Use a smaller excerpt or remove a source.');
	return next;
}

export async function openContextSources(workflow: ReviewWorkflow) {
	const { branchId, contextSources } = workflow;
	try {
		const updated = await editContextSources(contextSources);
		if (updated && !workflow.setContextSources(branchId, contextSources, updated)) {
			void vscode.window.showWarningMessage('The draft or its context changed. Open Context Sources again.');
		}
	} catch (error) {
		void vscode.window.showWarningMessage(error instanceof Error ? error.message : 'Unable to attach the source.');
	}
}
