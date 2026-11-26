// The host owns the validated frame. This view holds disclosure state and unfinished node edits.
function createReviewTree({snapshot, wording, revisions, post, send, saveWording, refresh, clarification}) {
	const $ = id => document.getElementById(id);
	const groups = [
		['Objective', ['objective']], ['Requirements', ['requirements']], ['Decisions', ['decisions']],
		['Work state', ['completed','deferred','queued','blocked']], ['Next move', ['nextMove']],
		['Relevant files', ['files']], ['Important context', ['context']], ['Unresolved', ['unresolved']],
	];
	const drafts = new Map();
	let proposalId, root = 'input', openNode, editingWording = false, showHistory = false;
	let wantsMapping = false, conflictNotice;
	let shownWording, highlightToken = 0, signature, fieldSave, frameId;
	let clarificationSession, clarificationStatus;
	const inline = s => s.clarificationEnabled ? s.clarification?.mapping : s.mapping;
	const sectionsFor = s => s.clarificationEnabled ? s.clarificationSections : s.sections;
	const element = (tag, value) => { const node = document.createElement(tag); if (value !== undefined) node.textContent = value; return node; };
	function button(label, action) {
		const b = element('button', label); b.type = 'button'; b.addEventListener('click', action); return b;
	}
	function toggleRoot(name) {
		if (name === 'mappings' && $('mappings-node').disabled) return;
		root = root === name ? undefined : name;
		if (root === 'mappings') {
			editingWording = false;
			const s = snapshot();
			wantsMapping = !s.clarificationEnabled && (s.rewrite?.checkedWording !== wording() || !s.mapping);
		}
		refresh();
	}
	function requestMap() {
		const s = snapshot();
		if (!s.rewrite || s.phase !== 'proposal' || s.rewrite.review.status === 'checking' || !wording().trim()) return;
		wantsMapping = false;
		send('check-mapping', {proposalId: s.rewrite.id, wording: wording(), inline: true});
	}
	$('input-node').onclick = () => toggleRoot('input');
	$('mappings-node').onclick = () => toggleRoot('mappings');
	$('clarification-node').onclick = () => toggleRoot('clarification');
	$('clarification-review').onclick = () => { root = 'clarification'; refresh(); $('clarification-node').focus(); };
	$('tree-retry').onclick = requestMap;
	$('rewrite-input').onclick = () => {
		const s = snapshot();
		if (s.phase === 'proposal') send('rewrite-input', {proposalId:s.rewrite.id, wording:wording()});
	};
	$('input-history').onclick = () => {
		root = 'input'; showHistory = !showHistory; refresh();
		if (showHistory) $('input-versions').querySelector('button')?.focus();
	};
	function beginWording() {
		if (snapshot().phase !== 'proposal' || drafts.size) return;
		editingWording = true; showHistory = false; refresh(); $('rewrite-text').focus();
	}
	$('input-read').ondblclick = beginWording;
	$('input-read').onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); beginWording(); } };
	function checkSelectedWording() {
		const s = snapshot();
		if (s.clarificationEnabled && s.rewrite && s.clarification?.wording !== wording()) {
			send('review-step-three-wording', {proposalId: s.rewrite.id, wording: wording()});
		}
	}
	$('done-wording').onclick = () => {
		editingWording = false;
		checkSelectedWording();
		refresh(); $('input-read').focus();
	};
	function versions(s, busy) {
		const rows = [['Original input',s.input ?? s.text],['Reviewed input',s.rewrite.text],
			...(s.rewrite.previousWordings ?? []).map(value => ['Earlier wording',value]),
			['Rewrite',s.rewrite.proposed], ...revisions().map(value => ['Earlier wording',value]), ['Current wording',wording()]];
		const seen = new Set();
		const holder = $('input-versions'); holder.replaceChildren();
		for (const [label,value] of rows) {
			if (seen.has(value)) continue;
			seen.add(value);
			const b = button('', () => {
				if (s.phase !== 'proposal') return;
				$('rewrite-text').value = value; saveWording(value);
				checkSelectedWording();
				showHistory = false; refresh(); $('input-history').focus();
			});
			b.append(element('strong',label), element('span',value));
			b.disabled = busy || value === wording() || s.phase !== 'proposal' || s.clarification?.status === 'blocked' || drafts.size > 0; holder.append(b);
		}
	}
	function highlights(message) {
		if (message.proposalId !== proposalId || message.token !== highlightToken) return;
		const box = $('input-read'), children = []; let end = 0;
		for (const range of message.ranges) {
			children.push(document.createTextNode(shownWording.slice(end, range.start)), element('mark',shownWording.slice(range.start, range.end)));
			end = range.end;
		}
		children.push(document.createTextNode(shownWording.slice(end))); box.replaceChildren(...children);
	}
	function fieldsFor(group, keys, sections, body, editing) {
		for (const key of keys) {
			const values = sections[key] ?? [];
			if (!editing && !values.length) continue;
			const title = key[0].toUpperCase() + key.slice(1);
			if (editing) {
				const label = element('label');
				if (keys.length > 1) label.append(element('span',title));
				const area = element('textarea'); area.value = editing.text[key];
				area.rows = Math.max(1, Math.min(8, area.value.split('\n').length));
				area.setAttribute('aria-label',keys.length > 1 ? title : group);
				area.oninput = () => { editing.text[key] = area.value; };
				label.append(area); body.append(label);
			} else {
				const line = element('div'); line.className = 'node-values';
				if (keys.length > 1) line.append(element('span',title));
				const list = element('ul'); for (const v of values) list.append(element('li',v));
				line.append(list); body.append(line);
			}
		}
	}
	function drawNodes(s) {
		const host = $('mapping-nodes'), m = inline(s), sections = sectionsFor(s);
		host.replaceChildren();
		if (!sections || !m?.frame || (s.clarificationEnabled ? s.clarification.wording !== wording() : s.rewrite?.checkedWording !== wording())) return;
		for (const [name,keys] of groups) {
			const lines = keys.flatMap(k => sections[k] ?? []);
			const decisions = name === 'Decisions' ? s.clarification?.decisions ?? [] : [];
			const draft = drafts.get(name);
			if (!lines.length && !draft && !decisions.length) continue;
			const opened = openNode === name;
			const row = element('div'); row.className = 'review-tree-row';
			const toggle = button(name, () => {
				openNode = opened ? undefined : name; refresh(); $(toggle.id)?.focus();
			});
			toggle.id = 'node-' + keys[0]; toggle.className = 'tree-toggle'; toggle.setAttribute('aria-expanded',String(opened));
			if (!opened && (name === 'Objective' || name === 'Decisions' || name === 'Work state')) {
				const hint = element('span',lines[0]); hint.className = 'tree-hint'; toggle.append(hint);
			}
			row.append(toggle); host.append(row); if (!opened) continue;
			const body = element('div'); body.className = 'tree-children node-body'; host.append(body);
			fieldsFor(name,keys,sections,body,draft);
			if (decisions.length) {
				const list = element('dl'); list.className = 'clarification-decisions';
				for (const decision of decisions) list.append(element('dt','Question'), element('dd',decision.question),
					element('dt','Answer'), element('dd',decision.answer));
				body.append(list);
			}
			if (!lines.length && !draft) continue;
			const edit = button(draft ? 'Done' : 'Edit', () => {
				if (!draft) {
					conflictNotice = undefined;
					drafts.set(name,{text:Object.fromEntries(keys.map(k=>[k,(sections[k] ?? []).join('\n')])),
						base:Object.fromEntries(keys.map(k=>[k,sections[k] ?? []]))});
					signature = undefined; refresh(); host.querySelector('textarea')?.focus(); return;
				}
				const live = snapshot(), mapping = inline(live), latestSections = sectionsFor(live);
				if (!mapping || !latestSections) return;
				const updates = {...mapping.frame.reviewFields};
				for (const key of keys) {
					const next = draft.text[key].split(/\r?\n/).map(v=>v.trim()).filter(Boolean);
					if (JSON.stringify(next) === JSON.stringify(draft.base[key])) continue;
					if (JSON.stringify(latestSections[key] ?? []) !== JSON.stringify(draft.base[key])) {
						conflictNotice = 'This entry changed in another view. Review the current value before editing.';
						drafts.delete(name); signature = undefined; refresh(); return;
					}
					updates[key] = next;
				}
				if (JSON.stringify(updates) === JSON.stringify(mapping.frame.reviewFields ?? {})) {
					drafts.delete(name); signature = undefined; refresh(); $(toggle.id)?.focus(); return;
				}
				fieldSave = name; edit.disabled = true;
				if (live.clarificationEnabled) send('save-step-three-mapping', {frameId:mapping.frame.id, editVersion:mapping.editVersion, fields:updates});
				else send('save-mapping', {proposalId, frameId:mapping.frame.id, editVersion:mapping.editVersion,
					frame:{...mapping.frame,reviewFields:updates}});
			});
			edit.disabled = !!fieldSave; row.append(edit);
		}
	}
	function result(type,status) {
		if ((type === 'save-mapping' || type === 'save-step-three-mapping') && fieldSave) {
			if (status === 'accepted') drafts.delete(fieldSave);
			fieldSave = undefined; signature = undefined;
		}
	}
	function mappingLockReason(s) {
		const review = s.rewrite?.review, q = s.clarification;
		if (review && review.wording !== wording()) return 'Select Done to check the edited wording.';
		if (review?.status === 'checking') return 'Checking the wording…';
		if (!q && review?.status === 'failed') return 'Retry the wording check to open Mappings.';
		if (review?.groups.length) return 'Review the flagged wording in Input.';
		if (q?.status === 'failed') return q.message || 'Retry the clarification check to open Mappings.';
		if (q?.status === 'blocked') return 'Return to Step 1 to revise the request.';
		if (q?.status === 'questions' && q.question?.blocking) return 'Resolve the blocking questions to open Mappings';
		return 'Checking the request…';
	}
	function render(s, visible, busy) {
		$('review-tree').hidden = !visible;
		const currentWording = wording();
		const q = s.clarification?.wording === currentWording ? s.clarification : undefined;
		const sessionChanged = s.clarification?.session !== clarificationSession;
		if (proposalId !== s.rewrite?.id || sessionChanged) {
			proposalId = s.rewrite?.id; root = 'input'; openNode = undefined;
			wantsMapping = editingWording = showHistory = false; conflictNotice = undefined; shownWording = signature = frameId = fieldSave = undefined; drafts.clear();
		}
		if (sessionChanged) { clarificationSession = s.clarification?.session; clarificationStatus = undefined; }
		const mapped = inline(s);
		const canMap = !s.clarificationEnabled || !!q?.mapping;
		const previousStatus = clarificationStatus;
		if (q?.status !== previousStatus) {
			clarificationStatus = q?.status;
			if (q?.status === 'blocked') root = 'input';
			else if (q?.status === 'ready') root = 'mappings';
			else if (q?.status === 'questions') root = 'clarification';
		}
		if (root === 'mappings' && !canMap) root = q?.question ? 'clarification' : 'input';
		const reviewing = q?.status === 'ready';
		const showQuestions = !!q?.question && q.status !== 'blocked' && (!reviewing || root === 'clarification');
		$('clarification-row').hidden = !showQuestions;
		const clarificationLabel = $('clarification-name');
		if (showQuestions && !reviewing) clarificationLabel.dataset.severity = q.severity;
		else delete clarificationLabel.dataset.severity;
		$('clarification-node').setAttribute('aria-expanded', String(showQuestions && root === 'clarification'));
		$('tree-clarification').hidden = !showQuestions || root !== 'clarification';
		$('mappings-node').disabled = !canMap;
		$('mappings-node').classList.toggle('mapping-locked', !canMap);
		$('mappings-node').title = canMap ? '' : mappingLockReason(s);
		$('clarification-terminal').hidden = q?.status !== 'blocked';
		$('clarification-review').hidden = !reviewing || !q.reached;
		const wordingFailed = !s.clarification && s.rewrite?.review.status === 'failed' && s.rewrite.review.wording === currentWording;
		clarification.render(q, visible && showQuestions && root === 'clarification', busy, reviewing, wordingFailed);
		$('rewrite-text').hidden = !visible || !editingWording || root !== 'input';
		if (!visible || (!s.rewrite && !q)) return;
		if (mapped?.frame && frameId !== mapped.frame.id) { frameId = mapped.frame.id; drafts.clear(); signature = undefined; }
		if (s.clarificationEnabled && !busy && (q?.status === 'resume' || (!s.clarification && s.phase === 'proposal' && s.rewrite.review.wording === currentWording &&
			s.rewrite.review.status === 'ready' && !s.rewrite.review.groups.length))) {
			Promise.resolve().then(() => { if (snapshot() === s) send('resume-clarification'); });
		}
		const inputOpen = root === 'input';
		$('tree-input').hidden = !inputOpen;
		$('rewrite-input').hidden = !inputOpen || !s.rewrite || q?.status === 'blocked';
		$('input-history').hidden = !inputOpen || !s.rewrite;
		$('tree-mappings').hidden = root !== 'mappings';
		$('input-node').setAttribute('aria-expanded',String(inputOpen));
		$('mappings-node').setAttribute('aria-expanded',String(root === 'mappings'));
		const mutable = !busy && s.phase === 'proposal' && s.rewrite?.review.status !== 'checking';
		$('rewrite-input').disabled = !mutable || drafts.size > 0 || !wording().trim();
		$('input-read').hidden = editingWording; $('done-wording').hidden = !editingWording;
		$('input-versions').hidden = !showHistory; $('input-history').setAttribute('aria-expanded',String(showHistory));
		if (showHistory && root === 'input' && s.rewrite) versions(s, busy);
		if (root === 'input' && !editingWording && shownWording !== wording()) {
			shownWording = wording(); $('input-read').textContent = shownWording;
			if (s.rewrite) post({type:'input-highlights',proposalId,token:++highlightToken,wording:shownWording});
		}
		const m = s.clarificationEnabled ? mapped : s.rewrite?.checkedWording === wording() ? s.mapping : undefined;
		const loading = m?.status === 'checking';
		const hasEntries = !!q?.decisions.length || Object.values(sectionsFor(s) ?? {}).some(values => values.length);
		$('tree-status').textContent = loading ? 'Checking mapping…' : conflictNotice ?? m?.message ?? (m?.frame && !hasEntries ? 'No mapping entries.' : '');
		$('tree-retry').hidden = !!m && m.status !== 'failed'; $('tree-retry').disabled = !mutable;
		if (root === 'mappings') {
			if (wantsMapping && mutable) {
				Promise.resolve().then(() => { if (wantsMapping && root === 'mappings' && s === snapshot() && !m) requestMap(); });
			}
			const stamp = JSON.stringify([m?.frame?.id,m?.editVersion,m?.status,openNode,fieldSave]);
			if (signature !== stamp) { signature = stamp; drawNodes(s); }
		}
		if (previousStatus === 'checking' && q?.status === 'blocked') $('clarification-terminal').focus();
		else if (previousStatus === 'checking' && q?.status === 'ready') $('mappings-node').focus();
		else if (previousStatus === 'checking' && q?.status === 'questions' && root === 'clarification')
			$('clarification-controls').querySelector('textarea, input, button')?.focus();
	}
	return {render, highlights, result, editing:() => editingWording || drafts.size > 0};
}
