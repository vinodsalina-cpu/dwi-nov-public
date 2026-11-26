import { createInterface } from 'node:readline';
import type { EditRequest } from '../edit-contract';
import { envelope } from './decode';
import { openModernBert } from './runtime';

async function main() {
	const runtime = await openModernBert(process.argv[2]);
	try {
		for await (const line of createInterface({ input: process.stdin, crlfDelay: Infinity })) {
			const message = JSON.parse(line);
			const parseOnly = message.operation === 'parse';
			const request: EditRequest = parseOnly ? message.request : message;
			let result;
			try {
				result = await runtime.infer(request, parseOnly);
			} catch (error) {
				process.stderr.write(`ModernBERT inference failed: ${error instanceof Error ? error.name : 'unknown'}\n`);
				result = { ...envelope(request), kind: 'failed', message: 'ModernBERT inference failed; the source is unchanged.' };
			}
			process.stdout.write(JSON.stringify(result) + '\n');
		}
	} finally {
		await runtime.dispose();
	}
}

void main().catch(error => {
	process.stderr.write(`ModernBERT startup failed: ${error instanceof Error ? error.name : 'unknown'}\n`);
	process.exitCode = 1;
});
