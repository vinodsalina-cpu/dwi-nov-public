import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { isAbsolute } from 'node:path';
import type { EditRequest } from './edit-contract';

export type ModernBertWorkerOptions = Readonly<{
	workingDirectory: string;
	timeoutMs?: number;
}> & (Readonly<{ python: string; checkpoint: string; baseDirectory?: string }> |
	Readonly<{ node: string; script: string }>);
type Pending = {
	resolve: (value: unknown) => void; reject: (error: Error) => void;
	cleanup: () => void; failure?: Error;
};

/** Opt-in prototype service for ReviewServices.rewrite. Owns and unloads only its child process. */
export class ModernBertWorker {
	private child?: ChildProcessWithoutNullStreams;
	private pending?: Pending;
	private output = '';
	private disposed = false;
	constructor(private readonly options: ModernBertWorkerOptions) {
		const paths = 'node' in options ? [options.node, options.script] : [options.python, options.checkpoint, options.baseDirectory];
		if (![options.workingDirectory, ...paths].every(path => path === undefined || isAbsolute(path))) {
			throw new Error('ModernBERT worker paths must be absolute.');
		}
	}

	readonly rewrite = (request: EditRequest, signal: AbortSignal) => this.run(request, signal, false);
	readonly parse = (request: EditRequest, signal: AbortSignal) => this.run(request, signal, true);

	private run(request: EditRequest, signal: AbortSignal, parseOnly: boolean): Promise<unknown> {
		signal.throwIfAborted();
		if (this.disposed) return Promise.reject(new Error('ModernBERT worker is disposed.'));
		if (this.pending) return Promise.reject(new Error('ModernBERT worker is busy.'));
		return new Promise((resolve, reject) => {
			const abort = () => this.stop(new Error('ModernBERT request cancelled.'));
			const timer = setTimeout(() => this.stop(new Error('ModernBERT worker timed out.')), this.options.timeoutMs ?? 120_000);
			this.pending = { resolve, reject, cleanup: () => { clearTimeout(timer); signal.removeEventListener('abort', abort); } };
			signal.addEventListener('abort', abort, { once: true });
			this.output = '';
			try {
				const child = this.child ?? this.start();
				const write = () => {
					if (this.child !== child || signal.aborted) return;
					child.stdin.write(JSON.stringify(parseOnly ? {operation: 'parse', request} : request) + '\n', error => {
						if (error && this.child === child) this.stop(error);
					});
				};
				if (child.pid) write();
				else child.once('spawn', write);
			} catch (error) {
				this.finish(undefined, error instanceof Error ? error : new Error(String(error)));
			}
		});
	}

	private start(): ChildProcessWithoutNullStreams {
		const options = this.options;
		const native = 'node' in options;
		const args = native ? [options.script, options.workingDirectory] : ['-m', 'dwi_modernbert.worker', '--checkpoint', options.checkpoint];
		if (!native && options.baseDirectory) {
			args.unshift('-I', '-B');
			args.push('--base-directory', options.baseDirectory);
		}
		const child = spawn(native ? options.node : options.python, args, {
			cwd: options.workingDirectory, stdio: ['pipe', 'pipe', 'pipe'], shell: false,
			env: {
				...process.env, TOKENIZERS_PARALLELISM: 'false',
				...(native ? { ELECTRON_RUN_AS_NODE: '1' } : { PYTHONUNBUFFERED: '1', HF_HUB_OFFLINE: '1' }),
			},
		});
		this.child = child;
		child.stdin.on('error', error => this.stop(error));
		child.stdout.setEncoding('utf8');
		child.stdout.on('data', (data: string) => {
			if (!this.pending || this.pending.failure) return;
			this.output += data;
			if (Buffer.byteLength(this.output) > 4 * 1024 * 1024) { this.stop(new Error('ModernBERT response exceeded the protocol budget.')); return; }
			const newline = this.output.indexOf('\n');
			if (newline < 0) return;
			try {
				if (this.output.slice(newline + 1).trim()) throw new Error('Unexpected extra worker output.');
				const result: unknown = JSON.parse(this.output.slice(0, newline));
				this.finish(result);
			} catch { this.stop(new Error('ModernBERT returned invalid JSON.')); }
		});
		// Drain diagnostics without exposing prompts or letting a full stderr pipe block the worker.
		child.stderr.resume();
		child.on('error', error => { if (this.child === child && this.pending) this.pending.failure = (error as NodeJS.ErrnoException).code === 'ENOENT'
			? new Error('The bundled model runtime is missing. Reinstall the DWI package for this platform.') : error; });
		child.on('close', () => {
			if (this.child !== child) return;
			this.child = undefined;
			this.finish(undefined, this.pending?.failure ?? new Error('ModernBERT worker exited before completing the request.'));
		});
		return child;
	}

	private finish(value?: unknown, error?: Error): void {
		const pending = this.pending;
		this.pending = undefined; this.output = '';
		if (!pending) return;
		pending.cleanup();
		if (error) pending.reject(error); else pending.resolve(value);
	}

	private stop(error: Error): void {
		if (this.pending) this.pending.failure = error;
		const child = this.child;
		if (!child) { this.finish(undefined, error); return; }
		child.kill('SIGTERM');
		const force = setTimeout(() => { if (this.child === child) child.kill('SIGKILL'); }, 2_000);
		force.unref();
		child.once('close', () => clearTimeout(force));
		// Cancellation settles on close, so a retry cannot overlap an unloading model.
	}

	async dispose(): Promise<void> {
		this.disposed = true;
		const child = this.child;
		if (!child) return;
		const closed = new Promise<void>(resolve => child.once('close', () => resolve()));
		this.stop(new Error('ModernBERT worker disposed.'));
		await closed;
	}
}
