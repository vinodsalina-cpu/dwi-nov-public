import { mkdir, open, readFile, readdir, rename, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { isRecordKey as isContractKey, isRecordSummary } from './contracts';
import type { RecordHeader, RecordInput, RecordKey, RecordStore, StoredRecord, WriteResult } from './contracts';

const FORMAT_VERSION = 1;
const MAX_ATTEMPTS = 4;
const MAX_HISTORY_RESULTS = 100;
type DiskRecord = { formatVersion: number; key: RecordKey; revision: number; summary: RecordInput['summary'] };

export class RecordCorruptionError extends Error {
	constructor(message: string) { super(message); this.name = 'RecordCorruptionError'; }
}

function validateKey(key: RecordKey): void {
	if (!isContractKey(key) || Object.keys(key).sort().join(',') !== (key.kind === 'project' ? 'kind,projectId' : 'kind,projectId,promptId') || !validId(key.projectId) || (key.kind === 'prompt' && !validId(key.promptId))) {
		throw new TypeError('Invalid project context record key');
	}
}
function validId(value: unknown): value is string { return typeof value === 'string' && value.length > 0 && Buffer.byteLength(value, 'utf8') <= 100 && /^[A-Za-z0-9._~-]+$/.test(value); }
function safePart(value: string): string { return Buffer.from(value, 'utf8').toString('hex'); }
function keyEqual(a: RecordKey, b: RecordKey): boolean {
	return isContractKey(a) && a.kind === b.kind && a.projectId === b.projectId && (a.kind !== 'prompt' || (b.kind === 'prompt' && a.promptId === b.promptId));
}
function isRecordKey(value: unknown): value is RecordKey {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
	const key = value as Record<string, unknown>;
	return isContractKey(key) && Object.keys(key).sort().join(',') === (key.kind === 'project' ? 'kind,projectId' : 'kind,projectId,promptId') && validId(key.projectId) && (key.kind !== 'prompt' || validId(key.promptId));
}
function validSummary(value: unknown): value is RecordInput['summary'] {
	if (!isRecordSummary(value)) return false;
	return Object.keys(value).every(key => ['title', 'createdAt', 'updatedAt', 'accessedAt', 'archivedAt', 'completed'].includes(key));
}
function asHeader(d: DiskRecord, recovered = false): RecordHeader & { recovered?: true } {
	return { key: d.key, revision: d.revision, summary: d.summary, ...(recovered ? { recovered: true as const } : {}) };
}
function isMissing(error: unknown): boolean { return (error as NodeJS.ErrnoException)?.code === 'ENOENT'; }
function transient(error: unknown): boolean { return ['EINTR', 'EPERM', 'EACCES', 'EBUSY', 'ENOTEMPTY', 'EEXIST'].includes((error as NodeJS.ErrnoException)?.code ?? ''); }

async function writeFileDurable(path: string, data: string): Promise<void> {
	const handle = await open(path, 'wx', 0o600);
	try { await handle.writeFile(data, 'utf8'); await handle.sync(); } finally { await handle.close(); }
}
async function syncDirectory(path: string): Promise<void> {
	try { const handle = await open(path, 'r'); try { await handle.sync(); } finally { await handle.close(); } }
	catch (error) {
		const { code, syscall } = error as NodeJS.ErrnoException;
		// Windows can deny fsync on a read-only directory handle after all files have been flushed.
		if (process.platform === 'win32' && syscall === 'fsync' && code === 'EPERM') return;
		if (!['EINVAL', 'ENOTSUP', 'EISDIR', 'EBADF', 'ENOSYS'].includes(code ?? '')) throw error;
	}
}

/** Immutable, directory-based record history. The root must be a private profile directory. */
export class FileRecordStore implements RecordStore {
	constructor(private readonly root: string, private readonly onCommit?: () => void) { if (!root) throw new TypeError('A profile directory is required'); }

	private recordDir(key: RecordKey): string {
		const base = join(this.root, 'projects', safePart(key.projectId));
		return key.kind === 'project' ? join(base, 'project') : join(base, 'prompts', safePart(key.promptId));
	}
	private async slots(key: RecordKey): Promise<{ slot: number; directory: string }[]> {
		const dir = await this.recordDir(key);
		let names: import('node:fs').Dirent[];
		try { names = await readdir(dir, { withFileTypes: true }); } catch (error) { if (isMissing(error)) return []; throw error; }
		return names.filter(entry => entry.isDirectory()).map(entry => ({ slot: Number(entry.name), name: entry.name })).filter(x => /^[1-9]\d{0,15}$/.test(x.name) && Number.isSafeInteger(x.slot))
			.map(x => ({ slot: x.slot, directory: join(dir, x.name) })).sort((a, b) => b.slot - a.slot);
	}
	private async readSlot(key: RecordKey, slot: number, directory: string, includePayload = true): Promise<StoredRecord | undefined> {
		let d: unknown;
		try { d = JSON.parse(await readFile(join(directory, 'metadata.json'), 'utf8')); }
		catch (error) { if (isMissing(error)) return undefined; if (error instanceof SyntaxError) return undefined; throw error; }
		if (!d || typeof d !== 'object' || Array.isArray(d)) return undefined;
		const value = d as Partial<DiskRecord>;
		if (Object.keys(value).sort().join(',') !== 'formatVersion,key,revision,summary' || value.formatVersion !== FORMAT_VERSION || value.revision !== slot || !Number.isSafeInteger(value.revision) || !value.key || !keyEqual(value.key, key) || !validSummary(value.summary)) return undefined;
		let payload: unknown;
		if (includePayload) {
			try {
				const decoded: unknown = JSON.parse(await readFile(join(directory, 'payload.json'), 'utf8'));
				if (!decoded || typeof decoded !== 'object' || !Object.hasOwn(decoded, 'value')) return undefined;
				payload = (decoded as { value: unknown }).value;
			}
			catch (error) { if (isMissing(error) || error instanceof SyntaxError) return undefined; throw error; }
		}
		return { ...asHeader(value as DiskRecord), ...(includePayload ? { value: payload } : {}) } as StoredRecord;
	}
	private async scan(key: RecordKey, includePayload = true): Promise<{ record?: StoredRecord; slots: { slot: number; directory: string }[]; anySlot: boolean }> {
		const slots = await this.slots(key);
		for (let i = 0; i < slots.length; i++) {
			const record = await this.readSlot(key, slots[i].slot, slots[i].directory, includePayload);
			if (record) return { record: i === 0 ? record : { ...record, recovered: true }, slots, anySlot: true };
		}
		return { slots, anySlot: slots.length > 0 };
	}
	async read(key: RecordKey): Promise<StoredRecord | undefined> {
		validateKey(key);
		const found = await this.scan(key);
		if (!found.record && found.anySlot) throw new RecordCorruptionError('No valid committed version exists for this record');
		return found.record;
	}
	async readRevision(key: RecordKey, revision: number): Promise<StoredRecord | undefined> {
		validateKey(key);
		if (!Number.isSafeInteger(revision) || revision < 1) throw new TypeError('Invalid revision');
		return this.readSlot(key, revision, join(this.recordDir(key), String(revision)));
	}
	async readProjectRevisions(projectId: string, limit: number): Promise<StoredRecord[]> {
		const key: RecordKey = { kind: 'project', projectId };
		validateKey(key);
		if (!Number.isSafeInteger(limit) || limit < 0) throw new TypeError('Invalid project history limit');
		if (limit === 0) return [];
		const maximum = Math.min(limit, MAX_HISTORY_RESULTS);
		const records: StoredRecord[] = [];
		for (const { slot, directory } of await this.slots(key)) {
			const record = await this.readSlot(key, slot, directory);
			if (record) records.push(record);
			if (records.length === maximum) break;
		}
		return records;
	}
	async list(kind: RecordKey['kind'], projectId?: string): Promise<RecordHeader[]> {
		if (kind !== 'project' && kind !== 'prompt') throw new TypeError('Invalid record kind');
		if (projectId !== undefined && !validId(projectId)) throw new TypeError('Invalid project ID');
		const projectsRoot = join(this.root, 'projects');
		let projects: string[];
		try { projects = projectId === undefined ? await readdir(projectsRoot) : [safePart(projectId)]; }
		catch (error) { if (isMissing(error)) return []; throw error; }
		const headers: RecordHeader[] = [];
		for (const projectPart of projects) {
			const projectDir = join(projectsRoot, projectPart);
			const projectKey: RecordKey = { kind: 'project', projectId: projectId ?? decodePart(projectPart) };
			if (kind === 'project') {
				try { const record = await this.scan(projectKey, false); if (record.record) headers.push(header(record.record)); } catch { /* malformed item is isolated */ }
				continue;
			}
			let promptParts: string[];
			try { promptParts = await readdir(join(projectDir, 'prompts')); } catch (error) { if (isMissing(error)) continue; throw error; }
			for (const promptPart of promptParts) {
				const key: RecordKey = { kind: 'prompt', projectId: projectKey.projectId, promptId: decodePart(promptPart) };
				try { const record = await this.scan(key, false); if (record.record) headers.push(header(record.record)); } catch { /* malformed item is isolated */ }
			}
		}
		return headers;
	}
	async write(key: RecordKey, expectedRevision: number | null, next: RecordInput): Promise<WriteResult> {
		validateKey(key);
		if (expectedRevision !== null && (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1)) throw new TypeError('Invalid expected revision');
		if (!next || !validSummary(next.summary) || !Object.hasOwn(next, 'value')) throw new TypeError('Invalid record input');
		let encodedValue: string;
		try { const encoded = JSON.stringify({ value: next.value }); if (encoded === undefined) throw new TypeError(); encodedValue = encoded; }
		catch { throw new TypeError('Record value must be JSON serializable'); }
		const checkedValue: unknown = JSON.parse(encodedValue);
		if (!checkedValue || typeof checkedValue !== 'object' || !Object.hasOwn(checkedValue, 'value')) throw new TypeError('Record value must be JSON serializable');
		const dir = await this.recordDir(key);
		await mkdir(dir, { recursive: true, mode: 0o700 });
		for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
			const found = await this.scan(key);
			if (!found.record && found.anySlot) throw new RecordCorruptionError('No valid committed version exists for this record');
			const current = found.record;
			if ((current?.recovered) || (expectedRevision === null ? !!current : current?.revision !== expectedRevision)) return { kind: 'conflict', current };
			if (current?.revision === Number.MAX_SAFE_INTEGER) throw new RangeError('Record revision limit reached');
			const revision = (current?.revision ?? 0) + 1;
			const target = join(dir, String(revision));
			const staging = join(dir, `.stage-${randomUUID()}`);
			await mkdir(staging, { mode: 0o700 });
			try {
				const disk: DiskRecord = { formatVersion: FORMAT_VERSION, key, revision, summary: next.summary };
				await writeFileDurable(join(staging, 'payload.json'), encodedValue);
				await writeFileDurable(join(staging, 'metadata.json'), JSON.stringify(disk));
				await syncDirectory(staging);
				try { await rename(staging, target); }
				catch (error) {
					let winner: StoredRecord | undefined;
					try { winner = await this.readSlot(key, revision, target); } catch { /* preserve original error */ }
					if (winner) { await rm(staging, { recursive: true, force: true }).catch(() => undefined); if (expectedRevision === null) return { kind: 'conflict', current: winner }; continue; }
					if (transient(error) && attempt + 1 < MAX_ATTEMPTS) { await rm(staging, { recursive: true, force: true }).catch(() => undefined); continue; }
					throw error;
				}
				// The revision directory is the commit point. A later directory fsync
				// failure cannot undo that commit and must not report it as failed.
				await syncDirectory(dir).catch(() => undefined);
				this.onCommit?.();
				return { kind: 'saved', record: { ...asHeader(disk), value: next.value } };
			} catch (error) {
				await rm(staging, { recursive: true, force: true }).catch(() => undefined);
				throw error;
			}
		}
		const current = await this.read(key);
		return { kind: 'conflict', current };
	}
}
function header(record: StoredRecord): RecordHeader { return { key: record.key, revision: record.revision, summary: record.summary }; }
function decodePart(value: string): string {
	try { const decoded = Buffer.from(value, 'hex').toString('utf8'); return safePart(decoded) === value ? decoded : ''; } catch { return ''; }
}
