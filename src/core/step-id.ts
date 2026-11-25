import { randomUUID } from 'node:crypto';

function compactUuid(uuid: string): string {
	return Buffer.from(uuid.replaceAll('-', ''), 'hex').toString('base64url');
}

export const stepId = () => compactUuid(randomUUID());

export function parseStepId(value: unknown): string | undefined {
	if (typeof value !== 'string') return;
	const id = value.trim();
	if (/^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/i.test(id)) return compactUuid(id);
	if (!/^[\w-]{22}$/.test(id)) return;
	const bytes = Buffer.from(id, 'base64url');
	if (bytes.toString('base64url') === id && (bytes[6] >> 4) === 4 && (bytes[8] >> 6) === 2) return id;
	return undefined;
}
