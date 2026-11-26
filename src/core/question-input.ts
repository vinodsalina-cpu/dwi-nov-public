export type FileAnswer = { uri: string; label: string };
export type Field =
	| { kind: 'value'; format: 'text' | 'integer' | 'decimal' | 'date' | 'time'; unit?: string; min?: number; max?: number; maxLength?: number }
	| { kind: 'choice'; options: readonly { id: string; label: string }[]; multiple?: boolean; other?: boolean }
	| { kind: 'file'; multiple?: boolean };
export type AnswerSpec = Field | { kind: 'fields'; fields: readonly { id: string; prompt: string; field: Field }[] };
export type FieldAnswer = string | { value: number; unit?: string } | { selected: string[]; other?: string } | FileAnswer[];
export type AnswerValue = FieldAnswer | { fields: Record<string, FieldAnswer> };
export type AnswerCheck = { ok: true; value: AnswerValue; alert?: string } | { ok: false; error: string };
const rejected = (error: string): AnswerCheck => ({ ok: false, error });
export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}
const controlCharacter = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u;
const numeric = /^[+-]?(?:\d+(?:\.\d+)?|\.\d+)(?:[ \t]+(.+))?$/u;
const safeText = (value: string, limit: number) => value.length <= limit && !controlCharacter.test(value);
const optionKey = (text: string) => text.trim().normalize('NFKC').toLowerCase().replace(/\s+/gu, ' ');

/** Parse a complete entry. File values must come from the host picker. */
export function validateAnswer(spec: AnswerSpec, input: unknown, files: readonly FileAnswer[] = []): AnswerCheck {
	if (spec.kind === 'fields') {
		if (!isRecord(input)) return rejected('Complete each field.');
		const fields: Record<string, FieldAnswer> = {};
		const alerts: string[] = [];
		for (const { id, prompt, field } of spec.fields) {
			const result = validateField(field, input[id], files);
			if (!result.ok) return rejected(`${prompt} ${result.error}`);
			fields[id] = result.value;
			if (result.alert) alerts.push(result.alert);
		}
		return { ok: true, value: { fields }, ...(alerts.length && { alert: alerts.join(' ') }) };
	}
	return validateField(spec, input, files);
}

function validateField(spec: Field, input: unknown, files: readonly FileAnswer[]):
	{ ok: true; value: FieldAnswer; alert?: string } | { ok: false; error: string } {
	if (spec.kind === 'file') {
		if (!Array.isArray(input) || !input.length || (!spec.multiple && input.length !== 1) || new Set(input).size !== input.length) {
			return { ok: false, error: 'Choose a file.' };
		}
		const selected: FileAnswer[] = [];
		for (const uri of input) {
			const file = files.find(item => item.uri === uri);
			if (!file) return { ok: false, error: 'Choose the file again.' };
			selected.push(file);
		}
		return { ok: true, value: selected.sort((a, b) => a.uri.localeCompare(b.uri)) };
	}
	if (spec.kind === 'choice') {
		if (!isRecord(input) || !Array.isArray(input.selected) || !input.selected.every(id => spec.options.some(option => option.id === id)) ||
			(!spec.multiple && input.selected.length > 1)) return { ok: false, error: 'Choose a listed option.' };
		const ids = input.selected;
		const selected = spec.options.filter(option => ids.includes(option.id)).map(option => option.id);
		const supplied = input.other !== undefined;
		const other = typeof input.other === 'string' ? input.other.trim() : '';
		const validOther = spec.other && /[^\p{White_Space}\p{Cf}]/u.test(other) && !/[\r\n]/u.test(other) && safeText(other, 256) &&
			!spec.options.some(option => optionKey(option.label) === optionKey(other));
		const alert = supplied && !validOther ? 'Other was discarded. Choose a listed option or enter a different value.' : undefined;
		if (!selected.length && !validOther) return { ok: false, error: alert ?? 'Choose an option.' };
		return { ok: true, value: { selected: validOther && !spec.multiple ? [] : selected, ...(validOther && { other }) }, ...(alert && { alert }) };
	}
	if (typeof input !== 'string' || !input.trim()) return { ok: false, error: 'Enter an answer.' };
	if (!safeText(input, spec.maxLength ?? 2_000)) return { ok: false, error: 'Enter a shorter answer using plain text.' };
	const text = input.trim().replace(/\r\n?/g, '\n');
	if (spec.format === 'text') return { ok: true, value: text };
	if (spec.format === 'date') {
		const time = /^\d{4}-\d{2}-\d{2}$/.test(text) ? Date.parse(text) : NaN;
		return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === text
			? { ok: true, value: text } : { ok: false, error: 'Enter a valid date (YYYY-MM-DD).' };
	}
	if (spec.format === 'time') return /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(text)
		? { ok: true, value: text } : { ok: false, error: 'Enter a valid time (HH:MM).' };
	const match = numeric.exec(text);
	const numberText = match && (match[1] ? text.slice(0, -match[1].length).trimEnd() : text);
	const value = Number(numberText);
	const wrongUnit = match?.[1] && match[1].toLowerCase() !== spec.unit?.toLowerCase();
	if (!match || wrongUnit || !Number.isFinite(value) || (spec.format === 'integer' && (!/^[+-]?\d+$/.test(numberText!) || !Number.isSafeInteger(value))) ||
		(spec.min !== undefined && value < spec.min) || (spec.max !== undefined && value > spec.max)) {
		const bounds = [spec.min !== undefined && `at least ${spec.min}`, spec.max !== undefined && `at most ${spec.max}`].filter(Boolean).join(' and ');
		return { ok: false, error: `Enter ${spec.format === 'integer' ? 'a whole number' : 'a number'}${spec.unit ? ' in ' + spec.unit : ''}${bounds ? ' (' + bounds + ')' : ''}.` };
	}
	return { ok: true, value: { value, ...(spec.unit && { unit: spec.unit }) } };
}

export function answerText(spec: AnswerSpec, value: AnswerValue): string {
	if (spec.kind === 'fields') {
		const fields = (value as { fields: Record<string, FieldAnswer> }).fields;
		return spec.fields.map(({ id, prompt, field }) => `${prompt} ${answerText(field, fields[id])}`).join('\n');
	}
	if (typeof value === 'string') return value;
	if (Array.isArray(value)) return value.map(file => file.label).join('\n');
	if ('selected' in value && spec.kind === 'choice') {
		return [...spec.options.filter(option => value.selected.includes(option.id)).map(option => option.label), value.other].filter(Boolean).join('\n');
	}
	return 'value' in value ? [value.value, value.unit].filter(part => part !== undefined).join(' ') : '';
}

export function answerInput(value: AnswerValue): unknown {
	if (typeof value === 'string') return value;
	if (Array.isArray(value)) return value.map(file => file.uri);
	if ('fields' in value) return Object.fromEntries(Object.entries(value.fields).map(([id, field]) => [id, answerInput(field)]));
	if ('value' in value) return String(value.value);
	return value;
}
