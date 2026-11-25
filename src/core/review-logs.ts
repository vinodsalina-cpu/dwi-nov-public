import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { promisify } from 'node:util';
import { gzip, gunzip } from 'node:zlib';
import pino from 'pino';
import type { MarkovRun } from './request-review';

const compress = promisify(gzip), expand = promisify(gunzip);
const pageSize = 50;

export type LogCapture = (id: string, step: number, revision: number, pass: string, run: MarkovRun) => void;

export class ReviewLogs {
	private db?: DatabaseSync;
	private writes = Promise.resolve();
	private writeWarning = false;
	private readonly logger = pino({base: undefined}, {write: line => {
		this.writes = this.writes.then(async () => {
			const {id, step, revision, pass, time, run} = JSON.parse(line);
			const payload = await compress(line);
			this.database().prepare('INSERT INTO runs(step_id, step, source, revision, pass, time, flags, body) VALUES(?,?,?,?,?,?,?,?)')
				.run(id, step, 'markov', revision, pass, time, run.flags.length, payload);
			this.writeWarning = false;
		}).catch(() => {
			if (!this.writeWarning) this.onError('A Markov log could not be saved.');
			this.writeWarning = true;
		});
	}});
	constructor(private readonly directory: string | undefined, private readonly enabled: () => boolean,
		private readonly onError: (message: string) => void) {}

	readonly capture: LogCapture = (id, step, revision, pass, run) => {
		if (this.enabled()) this.logger.info({id, step, source: 'markov', revision, pass, run});
	};

	private database() {
		if (!this.db) {
			if (this.directory) mkdirSync(this.directory, {recursive: true});
			const { DatabaseSync } = require('node:sqlite') as typeof import('node:sqlite');
			const db = new DatabaseSync(this.directory ? join(this.directory, 'review-logs.sqlite') : ':memory:');
			try {
				db.exec(`PRAGMA busy_timeout=2000; PRAGMA journal_mode=WAL;
					CREATE TABLE IF NOT EXISTS runs (seq INTEGER PRIMARY KEY, step_id TEXT NOT NULL, step INTEGER,
					source TEXT NOT NULL, revision INTEGER, pass TEXT, time INTEGER, flags INTEGER, body BLOB NOT NULL);
					CREATE INDEX IF NOT EXISTS runs_by_step ON runs(step_id, source, seq);`);
				this.db = db;
			} catch (error) { db.close(); throw error; }
		}
		return this.db;
	}
	async listPage(id: string, before = Number.MAX_SAFE_INTEGER) {
		await this.writes;
		if (!this.enabled()) return {rows: [], more: false};
		const rows = this.database().prepare(`SELECT seq, step, revision, pass, time, flags FROM runs
			WHERE step_id=? AND source='markov' AND seq<? ORDER BY seq DESC LIMIT ?`).all(id, before, pageSize + 1);
		return {rows: rows.slice(0, pageSize), more: rows.length > pageSize};
	}
	async read(id: string, seq: number) {
		await this.writes;
		if (!this.enabled()) return;
		const row = this.database().prepare("SELECT body FROM runs WHERE step_id=? AND source='markov' AND seq=?").get(id, seq);
		if (!(row?.body instanceof Uint8Array)) return;
		const line = await expand(row.body);
		return this.enabled() ? JSON.parse(line.toString()).run as MarkovRun : undefined;
	}
	async close() {
		await this.writes;
		this.db?.close(); this.db = undefined;
	}
}
