// The host sends a summary of its validated frame. Unsaved form edits stay separate.
function createMappingEditor(api) {
	const $ = id => document.getElementById(id);
	const fields = {actions:'Action', targets:'Target', scope:'Scope', conditions:'Condition', exceptions:'Exception',
		constraints:'Constraint', quantities:'Quantity', comparators:'Comparator', literals:'Literal', unresolved:'Unresolved point', evidence:'Supporting quote'};
	const listTitles = {actions:'Ordered actions', targets:'Targets', scope:'Scope', conditions:'Conditions', exceptions:'Exceptions',
		constraints:'Constraints', quantities:'Quantities', comparators:'Comparators', literals:'Literals', unresolved:'Unresolved points', evidence:'Supporting quotes'};
	let source, draft, baseVersion, saving = false, editingQuestion, currentQuestion, submitting = false;
	const answerDrafts = new Map();
	function displayClarification() {
		const preview = source.preview;
		currentQuestion = preview?.questions.find(q => q.id === editingQuestion) ?? preview?.pending;
		const q = currentQuestion;
		$('clarify').hidden = !q; $('final-view').hidden = !preview || !!q;
		$('copy-prompt').hidden = !preview || !!q;
		$('heading').textContent = q ? 'Clarify request' : 'Prompt preview';
		if (q) {
			$('question').textContent = q.question;
			$('question-quote').textContent = q.quotes.join(' … ');
			$('question-quote').hidden = !q.quotes.length;
			const saved = source.mapping.answers?.find(a => a.questionId === q.id);
			const value = answerDrafts.get(q.id) ?? saved?.text ?? '';
			if ($('answer').value !== value) $('answer').value = value;
			$('answer-next').disabled = submitting || !value.trim();
		} else if (preview) {
			$('original').textContent = preview.text;
			const list = $('answered'); list.replaceChildren();
			for (const item of source.mapping.answers ?? []) {
				const question = preview.questions.find(q => q.id === item.questionId);
				if (question) list.append(button(question.question + ' — ' + item.text, () => {
					editingQuestion = question.id; displayClarification(); $('answer').focus();
				}));
			}
		}
	}
	$('answer').oninput = () => {
		if (currentQuestion) answerDrafts.set(currentQuestion.id, $('answer').value);
		$('answer-next').disabled = submitting || !$('answer').value.trim();
	};
	$('clarify').onsubmit = event => {
		event.preventDefault();
		if (!currentQuestion || submitting || !$('answer').value.trim()) return;
		submitting = true; $('answer-next').disabled = true;
		api.postMessage({type:'answer-question', version:source.version, revision:source.revision,
			proposalId:source.proposalId, frameId:source.mappingId, editVersion:source.mapping.editVersion,
			questionId:currentQuestion.id, answer:$('answer').value});
	};
	$('copy-prompt').onclick = () => {
		if (source?.preview?.text !== undefined && !dirty()) api.postMessage({type:'copy-prompt',version:source.version,
			mappingId:source.mappingId, proposalId:source.proposalId});
	};
	const clone = value => JSON.parse(JSON.stringify(value));
	const el = (tag, text) => { const n = document.createElement(tag); if (text !== undefined) n.textContent = text; return n; };
	function button(text, fn, label) {
		const b = el('button', text); b.type = 'button'; b.addEventListener('click', fn);
		if (label) b.setAttribute('aria-label', label);
		return b;
	}
	function dirty() { return draft && JSON.stringify(draft) !== JSON.stringify(source.mapping.frame); }
	function controls() {
		const changed = !!dirty();
		$('copy-prompt').disabled = changed || saving;
		$('save').disabled = saving || !changed; $('discard').hidden = !changed; $('discard').disabled = saving;
		$('state').textContent = saving ? 'Saving…' : changed ? 'Unsaved changes' : source?.mapping?.editVersion ? 'Saved' : '';
	}
	function remember() {
		controls();
		const scratch = dirty() ? {frame:draft, editVersion:baseVersion} : null;
		api.postMessage({type:'scratch', frameId:draft.id, scratch});
	}
	function setValue(key,index,text) {
		const before = draft[key][index]; draft[key][index] = text;
		// Keep the parser's mirrored constraints in sync while retaining independent developer constraints.
		if (['conditions','exceptions','comparators','quantities'].includes(key)) {
			const derived = ['conditions','exceptions','comparators','quantities'].flatMap(k => draft[k]);
			draft.constraints = draft.constraints.filter(v => v !== before || derived.includes(v));
			if (text.trim() && !draft.constraints.includes(text)) draft.constraints.push(text);
		}
	}
	function drawSummary(summary) {
		const container = $('summary');
		container.replaceChildren();
		for (const [key, title] of [['objective','Objective'], ['requirements','Requirements'], ['decisions','Decisions'],['completed','Completed'],['deferred','Deferred'],['queued','Queued'],['blocked','Blocked'],['nextMove','Next move'],['files','Relevant files'],['context','Important context'],['unresolved','Unresolved']]) {
			const values = summary[key];
			if (!values?.length) continue;
			const section = el('section');
			section.append(el('h3', title));
			if (values.length === 1) section.append(el('p', values[0]));
			else {
				const list = el('ul');
				for (const value of values) list.append(el('li', value));
				section.append(list);
			}
			container.append(section);
		}
	}
	function select(label, options, value, change) {
		const s=el('select'); s.setAttribute('aria-label',label);
		for (const key of options) { const o=el('option',key.toLowerCase().replaceAll('_',' ')); o.value=key; o.selected=key===value; s.append(o); }
		s.addEventListener('change',()=>{change(s.value);remember();});return s;
	}
	function drawFields() {
		const form=$('fields'); form.replaceChildren();
		const group = name => { const f=el('fieldset');f.append(el('legend',name));form.append(f);return f; };
		group('Root intent').append(select('Root intent',[...source.tasks,'SEQUENCE','MULTI_INTENT','CONTEXT','UNKNOWN'],draft.root_intent,x=>{draft.root_intent=x;}));
		function populate(key, f) {
			f.dataset.field = key;
			f.replaceChildren(el('legend', listTitles[key]));
			for (const [i,value] of draft[key].entries()) {
				const row=el('div');row.className='row';
				if(key==='actions') row.append(select('Task label',source.tasks,draft.task_intents[i],v=>{draft.task_intents[i]=v;}),
					select('Action modality',source.modes,draft.modalities[i],v=>{draft.modalities[i]=v;}));
				const input=el('textarea');input.rows=1;input.value=value;input.setAttribute('aria-label',fields[key]);
				input.addEventListener('input', () => {
					setValue(key, i, input.value);
					if (['conditions','exceptions','quantities','comparators'].includes(key)) {
						populate('constraints', form.querySelector('[data-field="constraints"]'));
					}
					remember();
				});
				const remove=button('Remove',()=>{
					setValue(key,i,''); draft[key].splice(i,1);
					if(key==='actions'){draft.task_intents.splice(i,1);draft.modalities.splice(i,1);}
					drawFields();remember();$('fields').querySelector('[data-add="'+key+'"]').focus();
				},'Remove '+fields[key].toLowerCase());
				row.append(input,remove);f.append(row);
			}
			const add=button('Add',()=>{
				draft[key].push('');if(key==='actions'){draft.task_intents.push('OTHER');draft.modalities.push('unspecified');}
				drawFields();remember();const entries=$('fields').querySelectorAll('textarea[aria-label="'+fields[key]+'"]');entries[entries.length-1].focus();
			},'Add '+fields[key].toLowerCase());add.dataset.add=key;f.append(add);
		}
		for (const key of Object.keys(fields)) populate(key, group(listTitles[key]));
	}
	$('discard').onclick = () => {
		draft = clone(source.mapping.frame); baseVersion = source.mapping.editVersion;
		$('message').textContent = ''; drawFields(); remember();
	};
	$('fields').onsubmit = e => { e.preventDefault(); $('save').click(); };
	$('save').onclick = () => {
		if (saving || !dirty()) return;
		saving = true; controls(); $('fields').inert = true;
		api.postMessage({type:'save-mapping', frame:draft, frameId:draft.id, editVersion:baseVersion,
			proposalId:source.proposalId, version:source.version, revision:source.revision});
	};
	return function update(data) {
		if (data.type === 'copy-result') {
			if (data.version !== source?.version) return;
			$('message').textContent = data.ok ? (data.saved ? 'Saved and copied.' : 'Copied.')
				: data.saved ? 'Saved. Clipboard copy failed.' : data.saveFailed ? 'Could not save the prompt.'
				: data.stale ? 'The prompt changed. Review it before copying again.' : 'Copy failed. Select the prompt to copy it.';
			return;
		}
		if (!data.mapping) {source = draft = currentQuestion = editingQuestion = undefined; submitting = saving = false; answerDrafts.clear(); return;}
		const previous = source;
		const wasDirty = !!dirty();
		if (previous?.mappingId !== data.mappingId) { editingQuestion = undefined; submitting = false; answerDrafts.clear(); }
		const advance = submitting && data.result?.status === 'accepted';
		if (advance) { answerDrafts.delete(currentQuestion.id); editingQuestion = undefined; }
		if (data.result) submitting = false;
		source = data;
		displayClarification();
		if (advance) (currentQuestion ? $('answer') : $('copy-prompt')).focus();
		if (data.result) { saving = false; $('fields').inert = false; }
		const m = data.mapping;
		$('details').hidden = !m.frame;
		if (data.mappingId !== previous?.mappingId) { $('details').open = false; $('graph').open = false; }
		if (!m.frame) {
			draft = undefined; $('summary').replaceChildren(); $('fields').replaceChildren();
			$('message').textContent = m.message ?? 'Checking mapping…'; controls(); return;
		}
		drawSummary(data.summary);
		if (!draft || draft.id !== m.frame.id || data.result?.status === 'accepted' || (!wasDirty && m.editVersion !== baseVersion)) {
			baseVersion = m.editVersion;
			const scratch = data.scratch;
			draft = clone(scratch?.editVersion === baseVersion && scratch.frame?.id === m.frame.id ? scratch.frame : m.frame);
			$('message').textContent = $('summary').childElementCount ? '' : 'No summary items in this mapping.';
			drawFields();
		}
		$('graph').hidden = !m.parsed?.graph;
		if (m.parsed?.graph) $('graph-data').textContent = JSON.stringify(m.parsed.graph, null, 2);
		if (data.result && data.result.status !== 'accepted') $('message').textContent = data.result.notice ?? 'The mapping changed. Discard changes to reload it.';
		controls();
	};
}
