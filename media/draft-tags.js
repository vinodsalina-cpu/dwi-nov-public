// Search text belongs to the picker. Only an explicit selection updates the draft metadata.
function createDraftTags({editor, stagedInput, snapshot, busy, save}) {
	const $ = id => document.getElementById(id);
	const strip = $('draft-tags'), picker = $('tag-picker'), query = $('tag-query'), list = $('tag-options');
	const chips = {task: $('tag-task'), criticality: $('tag-criticality')};
	const levels = ['low', 'medium', 'high'];
	let mode, active = 0, matches = [], branch, visible = false;
	const body = () => editor.hidden ? stagedInput : editor;
	const prefix = $('tag-prefix');
	new ResizeObserver(() => {
		strip.parentElement.style.setProperty('--tag-width', prefix.getBoundingClientRect().width + 'px');
	}).observe(prefix);
	let selection, sent;
	const values = () => selection?.tags ?? snapshot()?.tags ?? {};
	const same = (a, b) => a?.task === b?.task && a?.criticality === b?.criticality;

	// Serialize confirmed metadata behind an outstanding edit without putting search text in that edit.
	function commit(tags) {
		selection = {step: snapshot().stepIds[0], base: selection ? selection.base : snapshot().tags, tags};
		close();
		render(visible);
	}
	function flush() {
		if (busy()) return;
		if (sent) acknowledge(same(snapshot()?.tags, sent) ? 'accepted' : 'stale');
		if (!selection) return;
		if (!same(snapshot().tags, selection.base) || same(selection.tags, snapshot().tags)) {
			selection = undefined;
			return;
		}
		sent = selection.tags;
		save(sent);
	}
	function acknowledge(status) {
		if (selection && status === 'accepted') selection.base = sent;
		else selection = undefined;
		sent = undefined;
	}
	const label = key => key === 'task' ? 'Task' : 'Criticality';

	function alignWithText() {
		strip.style.setProperty('--tag-scroll', (body().scrollTop || 0) + 'px');
	}
	function render(show) {
		const state = snapshot();
		if (selection && selection.step !== state?.stepIds[0]) selection = sent = undefined;
		flush();
		if (branch !== state?.history.activeBranch || !show) close(false);
		branch = state?.history.activeBranch;
		visible = show;
		for (const [key, chip] of Object.entries(chips)) {
			const value = values()[key];
			chip.hidden = !value;
			chip.textContent = value ? '/' + value : '';
			chip.title = chip.textContent;
			chip.setAttribute('aria-label', label(key) + ': ' + (value ?? ''));
		}
		strip.hidden = !visible || (!mode && !values().task && !values().criticality);
		if (!strip.hidden) alignWithText();
		if (mode) filter();
	}
	function close(refocus = true) {
		mode = undefined;
		query.value = '';
		query.setAttribute('aria-expanded', 'false');
		query.removeAttribute('aria-activedescendant');
		picker.hidden = true;
		list.replaceChildren();
		strip.hidden = !visible || (!values().task && !values().criticality);
		if (refocus) body().focus();
	}
	function filter() {
		const needle = query.value.trim().toLowerCase().replace(/\s+/g, '_');
		const task = snapshot()?.tasks ?? [];
		// At the start of the text, show criticality after a task. Searching also finds replacement tasks.
		const choices = mode === 'task' || !values().task ? task : mode === 'criticality' || !needle ? levels : [...levels, ...task];
		matches = choices.filter(value => value.toLowerCase().startsWith(needle))
			.concat(choices.filter(value => !value.toLowerCase().startsWith(needle) && value.toLowerCase().includes(needle)));
		active = Math.min(active, Math.max(0, matches.length - 1));
		const options = matches.map((value, i) => {
			const option = document.createElement('div');
			option.id = 'tag-option-' + i;
			option.setAttribute('role', 'option');
			option.setAttribute('aria-selected', String(i === active));
			option.textContent = value;
			option.addEventListener('mousedown', event => event.preventDefault());
			option.onclick = () => select(value);
			return option;
		});
		list.replaceChildren(...options);
		if (options[active]) query.setAttribute('aria-activedescendant', options[active].id);
		else query.removeAttribute('aria-activedescendant');
		$('tag-empty').hidden = matches.length !== 0;
	}
	function open(next) {
		if (!visible) return;
		body().scrollTop = 0;
		alignWithText();
		mode = next;
		active = 0;
		query.value = '';
		$('tag-label').textContent = next === 'auto' && values().task ? 'Criticality or replacement task' : label(next === 'auto' ? 'task' : next);
		picker.hidden = strip.hidden = false;
		query.setAttribute('aria-expanded', 'true');
		filter();
		query.focus();
	}
	function select(value) {
		if (!mode || !matches.includes(value)) return;
		const key = levels.includes(value) ? 'criticality' : 'task';
		commit({...values(), [key]: value});
	}
	function clear(key) {
		const tags = {...values()};
		delete tags[key];
		commit(tags);
	}
	for (const [key, chip] of Object.entries(chips)) {
		chip.onclick = () => {
			if (key === 'criticality' && !values().task) { chip.focus(); return; }
			open(key);
		};
		chip.onkeydown = event => {
			if (event.isComposing) return;
			if (event.key === 'Backspace' || event.key === 'Delete') clear(key);
			else if (event.key === '/') open(key === 'criticality' && !values().task ? 'task' : key);
			else if (event.key === 'ArrowLeft' && key === 'criticality' && values().task) chips.task.focus();
			else if (event.key === 'ArrowRight') (key === 'task' && values().criticality ? chips.criticality : body()).focus();
			else return;
			event.preventDefault();
		};
	}
	for (const surface of [editor, stagedInput]) {
		surface.addEventListener('scroll', () => { if (!strip.hidden && surface === body()) alignWithText(); }, {passive:true});
		const leading = () => visible && !surface.hidden && !surface.disabled && surface.selectionStart === 0 && surface.selectionEnd === 0;
		surface.addEventListener('beforeinput', event => {
			if (!event.isComposing && event.inputType === 'insertText' && event.data === '/' && leading()) {
				event.preventDefault(); open('auto');
			}
		});
		surface.addEventListener('keydown', event => {
			if (!leading() || event.isComposing || event.ctrlKey || event.metaKey || event.altKey) return;
			const last = values().criticality ? 'criticality' : values().task ? 'task' : undefined;
			if (event.key === '/') {
				event.preventDefault(); open('auto'); return;
			}
			else if (!event.shiftKey && last && event.key === 'ArrowLeft') chips[values().task ? 'task' : last].focus();
			else if (!event.shiftKey && last && event.key === 'Backspace') clear(last);
			else return;
			event.preventDefault();
		});
	}
	query.oninput = () => { active = 0; filter(); };
	query.onkeydown = event => {
		if (event.isComposing || event.keyCode === 229) return;
		switch (event.key) {
			case 'Escape': close(); break;
			case 'Tab': close(false); return;
			case 'Backspace':
				if (query.value) return;
				if (mode === 'task' || mode === 'criticality') clear(mode);
				else close();
				break;
			case 'Enter':
				if (matches.length) select(matches[active]); else close();
				break;
			case 'ArrowDown': case 'ArrowUp':
				if (matches.length) active = (active + (event.key === 'ArrowDown' ? 1 : -1) + matches.length) % matches.length;
				filter(); list.children[active]?.scrollIntoView?.({block:'nearest'}); break;
			default: return;
		}
		event.preventDefault();
	};
	query.addEventListener('blur', () => { if (mode) close(false); });
	return {render, acknowledge};
}
