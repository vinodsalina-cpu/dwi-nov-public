export type HistorySide = 'undo' | 'redo';
export type Timeline<T> = Readonly<{ past: T[]; current: T; future: T[] }>;

export function listActions<T>(line: Timeline<T>, side: HistorySide, label: (from: T, to: T) => string) {
	const stack = side === 'undo' ? line.past : line.future;
	return stack.map((state, i) => {
		const next = i + 1 < stack.length ? stack[i + 1] : line.current;
		return side === 'undo' ? label(state, next) : label(next, state);
	}).reverse();
}

// Skip one transition, then replay each later transition onto the surviving state.
// Future is a stack: its last item is the next redo.
export function omitAction<T>(line: Timeline<T>, side: HistorySide, index: number, replay: (from: T, to: T, onto: T) => T): Timeline<T> | undefined {
	const count = side === 'undo' ? line.past.length : line.future.length;
	if (!Number.isSafeInteger(index) || index < 0 || index >= count) return;
	const states = [...line.past, line.current, ...line.future.slice().reverse()];
	const omit = line.past.length + (side === 'undo' ? -index : 1 + index);
	const retained = states.slice(0, omit);
	for (let i = omit + 1; i < states.length; i++) retained.push(replay(states[i - 1], states[i], retained[retained.length - 1]));
	const cursor = line.past.length - Number(side === 'undo');
	return { past: retained.slice(0, cursor), current: retained[cursor], future: retained.slice(cursor + 1).reverse() };
}

const splitsCharacter = (text: string, offset: number) =>
	offset > 0 && /[\uD800-\uDBFF]/.test(text[offset - 1]) && /[\uDC00-\uDFFF]/.test(text[offset] ?? '');

export function spliceBetween(before: string, after: string) {
	let start = 0, tail = 0;
	const shared = Math.min(before.length, after.length);
	while (start < shared && before[start] === after[start]) start++;
	if (splitsCharacter(before, start) || splitsCharacter(after, start)) start--;
	while (tail < shared - start && before[before.length - 1 - tail] === after[after.length - 1 - tail]) tail++;
	if (splitsCharacter(before, before.length - tail) || splitsCharacter(after, after.length - tail)) tail--;
	return { start, end: before.length - tail, text: after.slice(start, after.length - tail) };
}

export function mapRange(start: number, end: number, from: string, onto: string) {
	if (from === onto) return { start, end };
	const gap = spliceBetween(from, onto);
	const delta = onto.length - from.length;
	if (end <= gap.start) return { start, end };
	if (start >= gap.end) return { start: start + delta, end: end + delta };
	return { start: Math.min(start, gap.start), end: Math.max(gap.start + gap.text.length, end + delta) };
}

// Track original character boundaries through a selective deletion. Later insertions inside
// a discarded edit remain individually addressable, even when the surrounding letters repeat.
export class TextReplay {
	private left: number[] = [];
	private right: number[] = [];

	range(start: number, end: number) {
		const offset = this.right[start];
		return { start: offset, end: Math.max(offset, this.left[end]) };
	}

	apply(from: string, to: string, onto: string) {
		if (!this.left.length) {
			const gap = spliceBetween(from, onto);
			const length = gap.end - gap.start;
			for (let i = 0; i <= from.length; i++) {
				const offset = i <= gap.start ? i : i >= gap.end ? i + onto.length - from.length :
					gap.start + Math.floor((i - gap.start) * gap.text.length / length);
				const boundary = splitsCharacter(onto, offset) ? offset - 1 : offset;
				this.left.push(boundary);
				this.right.push(!length && i === gap.start ? offset + gap.text.length : boundary);
			}
		}
		if (from === to) return onto;
		const edit = spliceBetween(from, to);
		const { start, end } = this.range(edit.start, edit.end);
		const delta = edit.text.length - (end - start);
		const inserted = Array.from({length: edit.text.length + 1}, (_, i) => start + i);
		const left = inserted.slice(), right = inserted;
		left[0] = this.left[edit.start];
		right[right.length - 1] = this.right[edit.end] + delta;
		this.left = this.left.slice(0, edit.start).concat(left, this.left.slice(edit.end + 1).map(n => n + delta));
		this.right = this.right.slice(0, edit.start).concat(right, this.right.slice(edit.end + 1).map(n => n + delta));
		return onto.slice(0, start) + edit.text + onto.slice(end);
	}
}

export function textActionLabel(from: string, to: string) {
	const edit = spliceBetween(from, to);
	const before = from.slice(edit.start, edit.end);
	return !before ? 'Insert “' + edit.text + '”' : !edit.text ? 'Remove “' + before + '”' : '“' + before + '” → “' + edit.text + '”';
}
