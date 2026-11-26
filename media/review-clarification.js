// The host validates answers, owns the queue, and resolves file/reference actions.
function createClarificationView({snapshot, send, post, loadDraft, storeDraft}) {
	const $ = id => document.getElementById(id);
	const form = $('clarification-form');
	const controls = $('clarification-controls');
	const element = (tag, content) => {
		const node = document.createElement(tag);
		if (content !== undefined) node.textContent = content;
		return node;
	};
	let key, questionId, readAnswer, renderedQuestion, renderedResponse, acknowledgedAlert, busy, finalSkip;
	const picked = new Map();
	const fileControls = new Map();
	const current = () => snapshot().clarification;
	const inputOf = state => state?.response?.input;
	const remember = () => { if (key && readAnswer) storeDraft(key, readAnswer()); };
	function request(type, field) {
		const s = snapshot();
		post({type, version: s.version, questionId, field});
	}

	function renderField(spec, initial, committed, label, field) {
		if (spec.kind === 'choice') {
			const group = element('div'); group.className = 'clarification-choices';
			const choices = spec.options.map(option => {
				const item = element('label');
				const input = element('input'); input.type = spec.multiple ? 'checkbox' : 'radio';
				input.name = 'choice-' + (field ?? 'answer'); input.checked = (initial?.selected ?? []).includes(option.id);
				item.append(input, element('span', option.label)); group.append(item);
				return {input, id: option.id};
			});
			controls.append(group);
			const other = element('input'); other.type = 'text'; other.value = initial?.other ?? '';
			other.className = 'clarification-answer'; other.hidden = initial?.other === undefined;
			other.setAttribute('aria-label', 'Other');
			if (spec.other) {
				const show = element('button', 'Other…'); show.type = 'button'; show.className = 'clarification-link';
				other.id = 'clarification-other-' + (field ?? 'answer');
				show.setAttribute('aria-controls', other.id);
				show.setAttribute('aria-expanded', String(!other.hidden));
				show.onclick = () => {
					other.hidden = !other.hidden;
					show.setAttribute('aria-expanded', String(!other.hidden));
					if (!other.hidden) {
						if (!spec.multiple) for (const {input} of choices) input.checked = false;
						other.focus();
					}
					remember();
				};
				for (const {input} of choices) input.addEventListener('change', () => {
					if (!spec.multiple && input.checked) { other.hidden = true; show.setAttribute('aria-expanded', 'false'); }
				});
				controls.append(show, other);
			}
			return () => ({selected: choices.filter(({input}) => input.checked).map(({id}) => id),
				...(!other.hidden && {other: other.value})});
		}
		if (spec.kind === 'file') {
			const button = element('button', 'Choose file…'); button.className = 'clarification-file'; button.type = 'button';
			const receipts = [...(Array.isArray(committed) ? committed : []), ...(picked.get(key + (field ?? '')) ?? [])];
			let files = (Array.isArray(initial) ? initial : []).flatMap(uri => receipts.filter(file => file.uri === uri).slice(0, 1));
			function show() {
				const names = files.map(file => file.label).join(', ');
				button.textContent = names || 'Choose file…';
				button.title = names;
				button.setAttribute('aria-label', names ? 'Choose another file. Selected: ' + names : 'Choose file');
			}
			fileControls.set(field, selected => { files = selected; show(); remember(); });
			button.onclick = () => request('clarification-pick-file', field);
			controls.append(button); show();
			return () => files.map(file => file.uri);
		}
		const answer = element(spec.format === 'text' ? 'textarea' : 'input');
		answer.className = 'clarification-answer'; answer.value = typeof initial === 'string' ? initial : '';
		answer.setAttribute('aria-label', label);
		if (spec.format === 'text') { answer.rows = 2; answer.spellcheck = false; }
		if (spec.format === 'date' || spec.format === 'time') answer.type = spec.format;
		if (spec.format === 'integer' || spec.format === 'decimal') answer.inputMode = 'decimal';
		if (spec.format === 'integer' || spec.format === 'decimal') {
			const hint = element('p'); hint.className = 'clarification-validation';
			hint.id = 'clarification-validation-' + (field ?? 'answer');
			const describe = [hint.id, ...(spec.unit ? ['clarification-unit-' + (field ?? 'answer')] : [])].join(' ');
			answer.setAttribute('aria-describedby', describe);
			answer.addEventListener('input', () => {
				const value = answer.value.trim();
				const match = /^[+-]?(?:\d+(?:\.\d+)?|\.\d+)(?:[ \t]+(.+))?$/u.exec(value);
				const number = match && Number(match[1] ? value.slice(0, -match[1].length) : value);
				const invalid = !!value && (!match || (match[1] && match[1].toLowerCase() !== spec.unit?.toLowerCase()) ||
					!Number.isFinite(number) || (spec.format === 'integer' && (!Number.isSafeInteger(number) ||
					!/^[+-]?\d+(?:[ \t]+.+)?$/u.test(value))) ||
					(spec.min !== undefined && number < spec.min) || (spec.max !== undefined && number > spec.max));
				answer.setAttribute('aria-invalid', String(invalid));
				hint.textContent = invalid ? 'Check the number' + (spec.unit ? ' and unit.' : '.') : '';
			});
			controls.append(hint);
		}
		if (spec.maxLength !== undefined) answer.maxLength = spec.maxLength;
		if (spec.unit) {
			const line = element('div'); line.className = 'clarification-value';
			const unit = element('span', spec.unit); unit.id = 'clarification-unit-' + (field ?? 'answer');
			line.append(answer, unit); controls.append(line);
		} else controls.append(answer);
		return () => answer.value;
	}

	function renderQuestion(state) {
		const { question, response } = state;
		questionId = question.id;
		finalSkip = false;
		key = state.session + ':' + question.id;
		fileControls.clear();
		controls.replaceChildren();
		$('clarification-question').textContent = question.prompt;
		const local = loadDraft(key) ?? inputOf(state);
		const committed = response?.value;
		const spec = question.control;
		if (spec.kind === 'fields') {
			const fields = spec.fields.map(({id, prompt, field}) => {
				const heading = element('p', prompt); heading.className = 'clarification-field-name'; controls.append(heading);
				return [id, renderField(field, local?.[id], committed?.fields?.[id], prompt, id)];
			});
			readAnswer = () => Object.fromEntries(fields.map(([id, read]) => [id, read()]));
		} else readAnswer = renderField(spec, local, committed, question.prompt);
		const reference = $('clarification-reference');
		reference.hidden = !question.reference;
		reference.textContent = question.reference?.label ?? '';
	}

	form.addEventListener('input', () => {
		finalSkip = false;
		$('clarification-alert').textContent = '';
		remember();
	});
	form.addEventListener('change', remember);
	form.addEventListener('submit', event => {
		event.preventDefault();
		if (busy || !questionId || !readAnswer) return;
		const input = readAnswer();
		const empty = value => typeof value === 'string' ? !value.trim() : Array.isArray(value) ? !value.length :
			value?.selected ? !value.selected.length && !value.other?.trim() : Object.values(value ?? {}).every(empty);
		if (finalSkip || (current()?.response?.skip && empty(input))) send('submit-clarification', {questionId, skip: true});
		else send('submit-clarification', {questionId, input});
	});
	$('clarification-reference').onclick = () => request('clarification-reference');
	$('clarification-skip').onclick = () => {
		if (current()?.position !== 6) send('submit-clarification', {questionId, skip: true});
		else { finalSkip = true; $('clarification-status').textContent = 'Skipped'; $('clarification-next').focus(); }
	};
	$('clarification-back').onclick = () => send('navigate-clarification', {questionId, position: current().position - 1});
	$('clarification-retry').onclick = () => send('resume-clarification');

	function render(state, visible, pending, review) {
		const {question} = state ?? {};
		const checking = state?.status === 'checking' || state?.status === 'resume';
		busy = pending || checking || !question || state?.status === 'failed';
		form.hidden = !visible || !question;
		const active = $('clarification-controls').contains(document.activeElement) || form.contains(document.activeElement);
		const nextKey = question && state.session + ':' + question.id;
		if (question && visible && (!renderedQuestion || nextKey !== key || JSON.stringify(state.response) !== renderedResponse)) {
			renderQuestion(state);
			renderedQuestion = question;
			renderedResponse = JSON.stringify(state.response);
			if (active) controls.querySelector('textarea, input, button')?.focus();
		}
		$('clarification-name').textContent = review ? 'Questions' : 'Awaiting clarifications';
		$('clarification-count').textContent = question ? (state.position + 1) + '/' + Math.max(state.total, state.reached) : '';
		$('clarification-node').setAttribute('aria-label', question
			? $('clarification-name').textContent + ', question ' + (state.position + 1) + ' of ' + Math.max(state.total, state.reached)
			: $('clarification-name').textContent);
		$('clarification-back').disabled = !!busy || !state?.position;
		$('clarification-skip').disabled = !!busy;
		$('clarification-next').disabled = !!busy;
		$('clarification-fields').disabled = !!busy;
		$('clarification-next').textContent = state?.position === 6 ? 'Confirm' : 'Next';
		$('clarification-status').textContent = checking ? 'Checking request…' : state?.status === 'failed' ? state.message ?? '' :
			visible && state?.response?.skip ? 'Skipped' : '';
		$('clarification-retry').hidden = state?.status !== 'failed';
		if (state?.alert !== acknowledgedAlert) {
			acknowledgedAlert = state?.alert;
			$('clarification-alert').textContent = state?.alert ?? '';
		}
	}

	function receive(data) {
		if (data.questionId !== questionId || current()?.question?.id !== questionId) return;
		if (data.type === 'clarification-files') {
			picked.set(key + (data.field ?? ''), data.files);
			fileControls.get(data.field)?.(data.files);
		}
		if (data.type === 'clarification-resource-error') $('clarification-alert').textContent = data.message;
	}

	function result(action, data) {
		if (action?.type !== 'submit-clarification') return;
		if (data.status === 'accepted') {
			storeDraft(action.draftKey, undefined);
			if (!data.clarification?.alert) $('clarification-alert').textContent = '';
			renderedQuestion = undefined;
		} else {
			for (const hint of controls.querySelectorAll('.clarification-validation')) hint.textContent = '';
			$('clarification-alert').textContent = data.notice ?? 'Check the answer.';
		}
	}
	return { render, receive, result, draftKey: () => key };
}
