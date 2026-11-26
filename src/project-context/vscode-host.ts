import * as vscode from 'vscode';
import { realpath, stat } from 'node:fs/promises';
import { basename, isAbsolute, relative, resolve, sep } from 'node:path';
import { createHash } from 'node:crypto';

export type WorkspaceRoot = Readonly<{ uri: vscode.Uri; canonicalPath: string; identity: string; name: string }>;

/** Resolve only available local folders. Identity combines filesystem identity and canonical location. */
export async function resolveWorkspaceRoots(): Promise<readonly WorkspaceRoot[]> {
	const roots: WorkspaceRoot[] = [];
	for (const folder of vscode.workspace.workspaceFolders ?? []) {
		if (folder.uri.scheme !== 'file') continue;
		try {
			const canonicalPath = await realpath(folder.uri.fsPath);
			const info = await stat(canonicalPath);
			if (!info.isDirectory()) continue;
			const identity = createHash('sha256').update(`${process.platform}\0${info.dev}\0${info.ino}\0${canonicalPath}`).digest('hex');
			roots.push({ uri: vscode.Uri.file(canonicalPath), canonicalPath, identity, name: folder.name || basename(canonicalPath) });
		} catch { /* unavailable roots are omitted */ }
	}
	return roots;
}

export function containsPath(root: string, candidate: string): boolean {
	if (!isAbsolute(root) || !isAbsolute(candidate)) return false;
	const path = relative(resolve(root), resolve(candidate));
	return path === '' || (path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

export function unsupportedStorageReason(uri: vscode.Uri): string | undefined {
	return uri.scheme !== 'file' ? `Project files require local file storage; this workspace uses ${uri.scheme} storage.` : undefined;
}

export function isSecretLikePath(path: string): boolean {
	return /(^|[/\\])\.env(?:\.|$)|(^|[/\\])(?:credentials?|secrets?)(?:\.|[/\\]|$)|\.(?:pem|key|p12|pfx)$/i.test(path);
}

export function hasObviousSecret(text: string): boolean {
	return /(-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----|\b(?:api[_-]?key|access[_-]?token|client[_-]?secret|password)\s*[:=]\s*['"]?\S{8,}|\bAKIA[0-9A-Z]{16}\b)/i.test(text);
}
