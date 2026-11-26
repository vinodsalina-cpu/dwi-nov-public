(() => {
	const vscode = acquireVsCodeApi();
	const $ = id => document.getElementById(id);
	const editor = $('request');
	const source = $('source');
	const stagedInput = $('step-input');
	const rewriteText = $('rewrite-text');
	const mappingReview = $('mapping-review');
	const archiveDialog = $('archive-dialog');
	const panel = $('inspector');
	const warning = $('warning');
	const replacement = $('replacement');
	const replacementWhitespace = /[\s\p{White_Space}]/u;
	let clippedReplacement = false, replacementComposing = false, reportedClipping = false;
	const ribbon = $('suggestions'), actionPanel = $('action-panel');
	let candidates = [], selected = -1, desiredChoice, queuedAction, returnToFlag;
	let actionMenu, menuToken = 0;
	const historyActions = { undo: 'canUndo', redo: 'canRedo', restore: 'canRestore' };
	let snapshot;
	let pending;
	let ackTimer;
	let saved = vscode.getState();
	let requestId = Number.isSafeInteger(saved?.requestId) ? saved.requestId : 0;
	let recoveredDraft = typeof saved?.draft === 'string' ? saved.draft : undefined;
	let wordingDrafts = Array.isArray(saved?.wordingDrafts) ? saved.wordingDrafts.filter(copy =>
		Number.isSafeInteger(copy?.id) && typeof copy.source === 'string' &&
		typeof copy.proposed === 'string' && typeof copy.wording === 'string') : [];
	const checkedProposals = new Set();
	let localBase;
	let localBranch;
	let archiveEdit = false;
	let recoveredEdits = Array.isArray(saved?.recoveredEdits) ? saved.recoveredEdits
		.map(copy => typeof copy === 'string' ? {text: copy, base: ''} : copy)
		.filter(copy => typeof copy?.text === 'string' && typeof copy.base === 'string') : [];
	let retriedEdit = false;
	let composing = false;
	let paintedVersion;
	let issues = [];
	let marks = [];
	let active = -1;
	let pinned = false;
	let hoverTimer;
	let closeTimer;
	let pageStep = saved?.stepView?.step ?? 1;
	let viewedBranch = saved?.stepView?.branch;
	let reached;
	let inputVersions = saved?.inputVersions ?? {};
	let clarificationDrafts = saved?.clarificationDrafts ?? {};
	let inputCheck;
	let previewId = 0;
	let archiveRequest;
	let readyCopyVersion, readyCopyResult;
	const tags = createDraftTags({editor, stagedInput, snapshot: () => snapshot,
		busy: () => !!pending || localBase !== undefined, save: value => send('set-draft-tags', {tags: value, previous: snapshot.tags ?? {}, stepId: snapshot.stepIds[0]})});
	const visibleEditor = () => [editor, source, stagedInput, rewriteText].find(field => !field.hidden);
	const currentWording = () => wordingDrafts.find(item => sameProposal(item, snapshot?.rewrite));
	// Textareas normalize CRLF on read. Until an input event, keep the host's exact string.
	const displayedWording = () => snapshot?.rewrite?.confirmed ?? currentWording()?.wording ??
		snapshot?.clarification?.wording ?? snapshot?.rewrite?.checkedWording ?? snapshot?.rewrite?.proposed ?? '';
	const readyToCopy = () => pageStep === 3 && snapshot?.clarification?.status === 'ready' &&
		snapshot.clarification.mapping && snapshot.clarification.wording === displayedWording();
	$('copy-ready-prompt').addEventListener('click', () => {
		if (!readyToCopy() || pending || reviewTree.editing() || readyCopyVersion !== undefined) return;
		const {frame, editVersion} = snapshot.clarification.mapping;
		readyCopyVersion = snapshot.version; readyCopyResult = undefined;
		vscode.postMessage({type: 'copy-ready-prompt', version: snapshot.version,
			proposalId: snapshot.rewrite?.id, frameId: frame.id, editVersion});
		render();
	});
	let previewRequested = pageStep === 4;
	const updateMapping = createMappingEditor({postMessage(message) {
		if (message.type === 'save-mapping' || message.type === 'answer-question') send(message.type, message);
		else vscode.postMessage(message);
	}});
	const clarification = createClarificationView({
		snapshot: () => snapshot, send, post: message => vscode.postMessage(message),
		loadDraft: key => clarificationDrafts[key],
		storeDraft(key, value) {
			if (!key || JSON.stringify(clarificationDrafts[key]) === JSON.stringify(value)) return;
			clarificationDrafts = {...clarificationDrafts};
			if (value === undefined) delete clarificationDrafts[key];
			else clarificationDrafts[key] = value;
			rememberPendingDraft();
		}
	});
	const reviewTree = createReviewTree({
		snapshot: () => snapshot, wording: displayedWording,
		revisions: () => currentWording()?.undo ?? [],
		post: message => vscode.postMessage(message), send, saveWording: exact => saveWording(undefined, exact), refresh: render, clarification,
	});
	const revisitingInput = () => pageStep === 1 && reached >= 2;
	const editingInput = () => revisitingInput() && stagedInput.value !== snapshot.input;
	let listedBranches = [];
	const checking = () => snapshot?.phase === 'checking-harper' || snapshot?.phase === 'rewriting';
	const opened = element => element.matches(':popover-open');

	const modules = createReviewModules(vscode, () => {
		if (!snapshot) return;
		const counts = revisitingInput() ? inputCheck : pageStep === 3 ? undefined : snapshot.history;
		const wording = pageStep === 3 && snapshot.phase === 'proposal' ? currentWording() : undefined;
		return {step: pageStep, name: $('step-' + pageStep).dataset.stepName, variant: viewedBranch + 1,
			id: editingInput() ? inputCheck?.stepId : snapshot.stepIds[pageStep - 1],
			undo: counts?.undoCount ?? wording?.undo?.length ?? 0, redo: counts?.redoCount ?? wording?.redo?.length ?? 0};
	}, resume => {
		if (resume && reached !== undefined) selectStep(reached);
		else (visibleEditor() ?? $('step-' + pageStep)).focus();
	}, () => { closeIssue(); closeActionMenu(); });

	function rememberPendingDraft() {
		// A discarded webview can recover unsent typing. Clear it as soon as the host acknowledges it.
		const draft = recoveredDraft ?? (localBase === undefined ? undefined : editor.value);
		if (snapshot?.rewrite?.checkedWording !== undefined) checkedProposals.add(snapshot.rewrite.id);
		const persistedWording = checkedProposals.size ? wordingDrafts.filter(copy => !checkedProposals.has(copy.id)) : wordingDrafts;
		const wording = persistedWording.length ? persistedWording : undefined;
		const draftBase = recoveredDraft !== undefined ? saved?.draftBase : localBase;
		const draftBranch = recoveredDraft !== undefined ? saved?.draftBranch : localBase !== undefined ? localBranch : undefined;
		if (saved?.draft === draft && saved?.draftBase === draftBase && saved?.draftBranch === draftBranch && saved?.requestId === requestId &&
			saved?.stepView?.branch === viewedBranch && saved?.stepView?.step === pageStep && saved?.inputVersions === inputVersions &&
			saved?.wordingDrafts === wording && saved?.recoveredEdits === recoveredEdits && saved?.clarificationDrafts === clarificationDrafts) return;
		saved = {requestId, draft, draftBase, draftBranch, stepView: {branch: viewedBranch, step: pageStep}, inputVersions, wordingDrafts: wording,
			recoveredEdits, clarificationDrafts};
		vscode.setState(saved);
	}
	function sameProposal(copy, proposal) {
		return proposal && copy.id === proposal.id && copy.source === proposal.text && copy.proposed === proposal.proposed;
	}
	function removeWording(copy) {
		wordingDrafts = wordingDrafts.filter(item => item !== copy);
		rememberPendingDraft();
	}
	function discardCopy(copy) {
		recoveredEdits = recoveredEdits.filter(item => item !== copy);
		removeWording(copy);
	}
	function closeIssue() {
		desiredChoice = queuedAction = undefined;
		clearTimeout(hoverTimer);
		clearTimeout(closeTimer);
		if (opened(panel)) panel.hidePopover();
		warning.setAttribute('aria-expanded', 'false');
		marks[active]?.classList.remove('current');
		active = -1;
		pinned = false;
	}
	// Generated candidate glyphs live in CSS. DOM text and selection offsets always refer to the raw draft.
	function sourceSelection() {
		const selection = window.getSelection?.();
		if (!selection?.rangeCount || !source.contains(selection.anchorNode) || !source.contains(selection.focusNode)) return;
		const offset = (node, end) => {
			const range = document.createRange();
			range.selectNodeContents(source);
			range.setEnd(node, end);
			return range.toString().length;
		};
		return [offset(selection.anchorNode, selection.anchorOffset), offset(selection.focusNode, selection.focusOffset)];
	}
	function restoreSelection(offsets) {
		if (!offsets) return;
		const point = offset => {
			const walker = document.createTreeWalker(source, 4);
			for (let node = walker.nextNode(); node; node = walker.nextNode()) {
				if (offset <= node.length) return [node, offset];
				offset -= node.length;
			}
			return [source, source.childNodes.length];
		};
		window.getSelection().setBaseAndExtent(...point(offsets[0]), ...point(offsets[1]));
	}
	function drawIssues(next) {
		const old = issues[active];
		const retain = opened(panel) && old && next.findIndex(issue =>
			issue.start === old.start && issue.end === old.end && editor.value.slice(issue.start, issue.end) === marks[active].dataset.original);
		const focused = marks.indexOf(document.activeElement?.closest('[data-issue]'));
		if (typeof retain !== 'number' || retain < 0) closeIssue();
		const selection = sourceSelection();
		const scroll = source.scrollTop;
		issues = next;
		marks = [];
		const top = document.createDocumentFragment();
		let end = 0;
		for (const [i, issue] of next.entries()) {
			const gap = editor.value.slice(end, issue.start);
			top.append(gap);
			const word = editor.value.slice(issue.start, issue.end);
			const annotation = document.createElement('span');
			annotation.dataset.issue = String(i);
			const stop = document.createElement('span');
			stop.className = 'flag-stop'; stop.tabIndex = 0;
			stop.setAttribute('role', 'button'); stop.setAttribute('contenteditable','false');
			stop.setAttribute('aria-label', 'Review ' + (word || 'insertion'));
			annotation.append(stop);
			annotation.dataset.original = word;
			if (issue.replacement === undefined) {
				const mark = document.createElement('mark');
				mark.className = 'unresolved';
				mark.textContent = word;
				annotation.append(mark);
			} else {
				if (issue.minor) {
					annotation.classList.add('minor-correction');
					annotation.title = 'Minor correction';
					stop.setAttribute('aria-label', 'Review minor correction: ' + (word || 'insertion') + ' → ' + (issue.replacement || 'delete'));
				}
				const original = document.createElement('del');
				original.textContent = word;
				const candidate = document.createElement('span');
				candidate.className = 'candidate';
				candidate.setAttribute('contenteditable', 'false');
				candidate.dataset.display = issue.replacement || '∅';
				candidate.setAttribute('aria-label', issue.replacement || 'Delete');
				annotation.append(original, candidate);
			}
			top.append(annotation);
			marks.push(annotation);
			end = issue.end;
		}
		top.append(editor.value.slice(end));
		source.replaceChildren(top);
		restoreSelection(selection);
		source.scrollTop = scroll;
		if (focused >= 0 && marks.length) marks[Math.min(focused, marks.length - 1)].firstElementChild.focus({preventScroll: true});
		if (typeof retain === 'number' && retain >= 0) {
			active = retain;
			marks[active].classList.add('current');
			renderCandidates();
			locateActive(false);
		}
		const count = next.filter(issue => issue.replacement === undefined).length;
		$('signal').hidden = !count;
		$('warning-count').textContent = String(count);
		$('warning-tip').textContent = count + (count === 1 ? ' unresolved word' : ' unresolved words');
		warning.setAttribute('aria-label', $('warning-tip').textContent);
	}
	function fragmentRects(index) {
		return Array.from(marks[index].getClientRects());
	}
	function place(rect) {
		const bounds = panel.getBoundingClientRect();
		const gap = 5;
		const center = (rect.left + rect.right - bounds.width) / 2;
		let x = Math.max(gap, Math.min(center, innerWidth - bounds.width - gap));
		const above = rect.top - bounds.height - gap;
		const below = Math.max(gap, Math.min(rect.bottom + gap, innerHeight - bounds.height - gap));
		let y = above >= gap ? above : below;
		const tools = $('tools').getBoundingClientRect();
		if (y < tools.bottom && y + bounds.height > tools.top && x + bounds.width > tools.left && x < tools.right) {
			const beside = tools.left - gap - bounds.width;
			if (beside >= gap && rect.left <= tools.left - gap) x = beside;
			else y = below;
		}
		panel.style.left = x + 'px';
		panel.style.top = y + 'px';
	}
	function locateActive(scroll, pointerY) {
		const box = source.getBoundingClientRect();
		let rects = fragmentRects(active);
		let rect = rects.find(r => r.top <= pointerY && r.bottom >= pointerY) ??
			rects.find(r => r.bottom > box.top && r.top < box.bottom);
		if (!rect && scroll && rects.length) {
			source.scrollTop += rects[0].top - box.top - box.height / 3;
			rects = fragmentRects(active);
			rect = rects.find(r => r.bottom > box.top && r.top < box.bottom);
		}
		if (rect && rect.bottom > 0 && rect.top < innerHeight) place(rect);
		else closeIssue();
	}
	function openIssue(index, pin, pointerY) {
		const issue = issues[index];
		if (!issue || snapshot?.batch?.status !== 'ready' || paintedVersion !== snapshot.version || pending || localBase !== undefined || opened($('history-panel')) || opened(actionPanel) || opened($('info-panel'))) return;
		clearTimeout(closeTimer);
		clearTimeout(hoverTimer);
		if (active === index && opened(panel)) { pinned ||= pin; return; }
		marks[active]?.classList.remove('current');
		active = index;
		pinned = pin;
		marks[index].classList.add('current');
		const word = editor.value.slice(issue.start, issue.end);
		desiredChoice = queuedAction = undefined;
		panel.setAttribute('aria-label', 'Actions for ' + (word || 'insertion'));
		$('keep-term').disabled = !word.trim();
		setCustom(false);
		if (!opened(panel)) panel.showPopover();
		renderCandidates();
		warning.setAttribute('aria-expanded', 'true');
		locateActive(pin, pointerY);
	}
	function setCustom(custom) {
		$('choices').hidden = custom;
		$('correction').hidden = !custom;
		if (custom) {
			replacement.value = '';
			clippedReplacement = replacementComposing = reportedClipping = false;
			$('replace').disabled = true;
			replacement.focus();
		}
	}
	function renderCandidates() {
		const issue = issues[active];
		candidates = [...issue.candidates];
		if (issue.replacement !== undefined && !candidates.includes(issue.replacement)) candidates.unshift(issue.replacement);
		selected = candidates.indexOf(desiredChoice?.value ?? issue.replacement);
		if (selected < 0 && candidates.length) selected = 0;
		const scores = candidates.map(value => issue.candidateContextScores?.[value]);
		const bestScore = Math.max(...scores.filter(Number.isFinite));
		ribbon.replaceChildren(...candidates.map((value, index) => {
			const button = document.createElement('button'), label = document.createElement('span');
			button.type = 'button'; button.tabIndex = -1;
			label.textContent = value || '∅';
			button.title = value || 'Remove text';
			if (Number.isFinite(scores[index])) {
				// Nearby scores retain similar fills, even when their list positions differ.
				const emphasis = 100 * Math.exp((scores[index] - bestScore) / 2.5);
				button.style.setProperty('--candidate-emphasis', emphasis.toFixed(1) + '%');
			}
			button.append(label);
			button.addEventListener('click', () => pickCandidate(index));
			return button;
		}));
		$('previous').disabled = $('next').disabled = candidates.length < 2;
		fitRibbon();
	}
	function fitRibbon() {
		if (!opened(panel) || $('choices').hidden) return;
		const buttons = [...ribbon.children], current = buttons[selected];
		for (const button of buttons) button.hidden = false;
		const widthOf = button => button.firstElementChild.offsetWidth + 8;
		$('apply-candidate').disabled = !current;
		const width = current ? Math.max(candidates.length > 1 ? 256 : 200, widthOf(current) + 185) : 200;
		panel.style.width = Math.min(width, 320) + 'px';
		const room = ribbon.clientWidth;
		let available = room - (current ? widthOf(current) : 0);
		for (let i = 0; i < buttons.length; i++) {
			buttons[i].setAttribute('aria-pressed', String(i === selected));
			buttons[i].classList.remove('overflowing');
			buttons[i].hidden = i !== selected;
		}
		if (!current) return;
		// Only show complete neighbours. Keep the selected word visible when the panel narrows.
		for (const direction of [1, -1]) {
			for (let i = selected + direction; buttons[i]; i += direction) {
				buttons[i].hidden = false;
				const needed = widthOf(buttons[i]) + 2;
				if (needed > available) { buttons[i].hidden = true; break; }
				available -= needed;
			}
		}
		const travel = widthOf(current) - room;
		if (travel > 1) {
			current.style.setProperty('--travel', -travel + 'px');
			current.style.setProperty('--travel-time', Math.max(3, travel / 32 + 1.5) + 's');
			current.classList.add('overflowing');
		}
	}
	function pickCandidate(index) {
		const issue = issues[active];
		if (!issue || !candidates.length) return;
		selected = index;
		pinned = true;
		desiredChoice = {start: issue.start, end: issue.end, value: candidates[index], branch: viewedBranch, text: snapshot.text};
		fitRibbon();
		flushChoice();
	}
	function flushChoice() {
		const target = desiredChoice, issue = issues[active];
		if (pending || snapshot.batch?.status !== 'ready') return;
		if (!target) {
			if (queuedAction) {
				const {type, payload, branch, text} = queuedAction;
				queuedAction = undefined;
				if (branch === viewedBranch && text === snapshot.text && payload.start === issue?.start && payload.end === issue?.end) send(type, payload);
			}
			return;
		}
		desiredChoice = undefined;
		if (viewedBranch === target.branch && snapshot.text === target.text && issue?.start === target.start &&
			issue.end === target.end && issue.replacement !== target.value) {
			send('choose', {start: target.start, end: target.end, replacement: target.value});
		} else if (queuedAction) flushChoice();
	}
	function applyWordAction(type, payload) {
		queuedAction = {type, payload, branch: viewedBranch, text: snapshot.text};
		flushChoice();
	}
	function cycleCandidate(offset) {
		if (candidates.length > 1) pickCandidate((selected + offset + candidates.length) % candidates.length);
	}
	function controls() {
		modules.updateInfo();
		const blocked = Boolean(pending) || composing || localBase !== undefined;
		for (const step of [1, 2, 3, 4]) $('step-' + step).disabled = blocked;
		for (const [action, prop] of Object.entries(historyActions)) {
			$(action).disabled = !snapshot?.history[prop] || blocked;
		}
		$('history').disabled = !snapshot || !(listedBranches.length || snapshot.approvals.length || snapshot.history.canRestore);
		editor.disabled = !snapshot;
		editor.readOnly = Boolean(pending && pending.type !== 'edit' && pending.type !== 'set-draft-tags');
		$('review').disabled = blocked || (pageStep === 2 ? checking() || (!snapshot?.rewrite && snapshot?.batch && !snapshot.canNext && snapshot.batch.status !== 'failed') : revisitingInput() ? editingInput() && !inputCheck?.canNext : !snapshot?.canNext);
		stagedInput.readOnly = Boolean(pending);
		if (revisitingInput() || pageStep === 3) {
			const copy = snapshot?.phase === 'proposal' ? currentWording() : undefined;
			$('undo').disabled = blocked || !(revisitingInput() ? inputCheck?.canUndo : copy?.undo?.length);
			$('redo').disabled = blocked || !(revisitingInput() ? inputCheck?.canRedo : copy?.redo?.length);
		}
		const editable = editor.readOnly ? 'false' : 'plaintext-only';
		if (source.getAttribute('contenteditable') !== editable) source.setAttribute('contenteditable', editable);
		const checkingWording = snapshot?.rewrite?.review.status === 'checking';
		$('check-mapping').disabled = blocked || reviewTree.editing() || snapshot?.phase !== 'proposal' || checkingWording || !displayedWording().trim() ||
			(snapshot?.clarificationEnabled && !snapshot?.clarification?.mapping);
		$('mapping-back').disabled = $('retry-mapping').disabled = blocked;

		$('approvals').inert = $('branches').inert = blocked;
	}
	function send(type, payload = {}) {
		if (pending || (!snapshot && type !== 'sync')) return;
		const committingWord = type === 'choose' && (payload.apply || payload.custom);
		if (active >= 0 && panel.contains(document.activeElement) && (type === 'validate' || committingWord)) {
			returnToFlag = {start: issues[active].start, branch: viewedBranch, text: snapshot.text};
		}
		if (type !== 'choose' || committingWord) closeIssue();
		// Correlate only our acknowledgements; worker broadcasts can arrive between them.
		pending = {type, requestId: ++requestId, text: editor.value, version: snapshot?.version, backStep: payload.backStep,
			draftKey: type === 'submit-clarification' ? clarification.draftKey() : undefined};
		rememberPendingDraft();
		controls();
		clearTimeout(ackTimer);
		ackTimer = setTimeout(() => {
			// A lost acknowledgement leaves the outcome unknown. Reconcile once without replaying the command.
			if (type !== 'sync') return reconnect();
			const retry = document.createElement('button');
			retry.type = 'button';
			retry.textContent = 'Reconnect';
			retry.addEventListener('click', reconnect);
			$('notice').replaceChildren('Waiting for the review host. ', retry);
		}, 5000);
		vscode.postMessage({type, requestId, revision: snapshot?.revision, version: snapshot?.version, ...payload});
	}
	function reconnect() {
		pending = undefined;
		send('sync');
	}
	document.addEventListener('visibilitychange', () => {
		if (document.visibilityState === 'visible') reconnect();
	});
	function branchRow(entry, index) {
		const row = document.createElement('li');
		const open = document.createElement('button');
		open.type = 'button';
		open.className = 'branch-title';
		open.textContent = open.title = entry.title.trim() || 'Empty draft';
		open.addEventListener('click', () => {
			$('history-panel').hidePopover();
			if (entry.copy) {
				entry.copy.key ??= crypto.randomUUID();
				send('open-copy', {key: entry.copy.key, base: entry.base, text: entry.title});
			} else send('open-branch', {id: entry.id});
		});
		const more = document.createElement('button');
		more.type = 'button';
		more.className = 'branch-more';
		more.textContent = '⋯';
		more.title = 'More actions';
		more.setAttribute('aria-label', 'More actions for ' + open.title);
		const menu = document.createElement('div');
		menu.className = 'popover branch-menu';
		menu.id = 'branch-options-' + index;
		menu.setAttribute('popover', 'auto');
		more.setAttribute('popovertarget', menu.id);
		const discard = document.createElement('button');
		discard.type = 'button';
		discard.textContent = 'Discard';
		discard.addEventListener('click', () => {
			menu.hidePopover();
			if (entry.copy) {
				discardCopy(entry.copy);
				render();
			} else send('discard-branch', {id: entry.id});
		});
		menu.append(discard);
		row.append(open, more, menu);
		return row;
	}
	function historyPanel() {
		const proposal = snapshot.rewrite;
		const branches = [
			...wordingDrafts.filter(copy => copy.wording !== copy.proposed && !snapshot.history.branches.some(branch => branch.proposalId === copy.id) &&
				(!sameProposal(copy, proposal) || proposal.confirmed !== undefined))
				.map(copy => ({title: copy.wording, base: copy.proposed, copy})),
			...recoveredEdits.map(copy => ({title: copy.text, base: copy.base, copy})),
			...snapshot.history.branches,
		];
		if (branches.length !== listedBranches.length || branches.some((item, i) =>
			item.id !== listedBranches[i].id || item.copy !== listedBranches[i].copy || item.title !== listedBranches[i].title)) {
			const list = $('branches');
			const focused = [...list.children].findIndex(row => row.contains(document.activeElement));
			list.replaceChildren(...branches.map(branchRow));
			if (focused >= 0 && opened($('history-panel'))) {
				(list.children[Math.min(focused, branches.length - 1)]?.firstElementChild ?? $('history')).focus();
			}
			listedBranches = branches;
		}
		$('history-heading').textContent = branches.length ? 'Other drafts' : 'No other drafts';
		$('approved').replaceChildren();
		$('approvals').hidden = !snapshot.approvals.length;
		for (const approval of snapshot.approvals) {
			const row = document.createElement('li');
			const undo = document.createElement('button');
			undo.type = 'button'; undo.textContent = 'Revoke';
			undo.addEventListener('click', () => { $('history-panel').hidePopover(); send('revoke', {id: approval.id}); });
			row.append(approval.word.text + (approval.scope === 'term' ? ' · All matches' : ' · Once') + (approval.reason ? ' · ' + approval.reason : ''), undo);
			$('approved').append(row);
		}
	}
	function selectStep(step) {
		if (!snapshot || step > reached || pending || composing || localBase !== undefined) return;
		if (step < 4 && snapshot.mapping) return send('back-from-mapping', {proposalId: snapshot.rewrite.id, backStep: step});
		pageStep = step;
		closeIssue();
		render();
		$('step-' + step).focus();
	}
	for (const step of [1, 2, 3, 4]) $('step-' + step).addEventListener('click', () => selectStep(step));


	function render() {
		const { phase, batch, rewrite, history, mapping } = snapshot;
		const last = mapping && previewRequested ? 4 : rewrite || snapshot.clarification ? 3 : batch?.expanded || ['ready','harper-reviewed','checking-harper','rewriting'].includes(phase) ? 2 : 1;
		const switched = history.activeBranch !== viewedBranch;
		const advance = reached !== undefined && last > reached && pageStep === reached;
		if (switched || advance) pageStep = last;
		if (!mapping && !pending) previewRequested = false;
		pageStep = Math.min(pageStep, last);
		if (switched) inputCheck = undefined;
		viewedBranch = history.activeBranch;
		reached = last;
		for (const step of [1, 2, 3, 4]) {
			const ball = $('step-' + step);
			ball.hidden = step > last;
			if (step === pageStep) ball.setAttribute('aria-current', 'step');
			else ball.removeAttribute('aria-current');
		}
		if (archiveDialog.open && (!archiveRequest || archiveRequest.version !== snapshot.version)) archiveDialog.close();
		editor.hidden = pageStep !== 1 || revisitingInput();
		stagedInput.hidden = !revisitingInput();
		source.hidden = pageStep !== 2;
		tags.render(pageStep === 1);
		document.querySelector('.workbench').classList.toggle('step-three', pageStep >= 3);
		mappingReview.hidden = pageStep !== 4;
		$('copy-prompt').hidden = pageStep !== 4 || !snapshot.preview || !$('clarify').hidden || snapshot.preview.text === undefined;
		$('tools').hidden = $('draft-info').hidden = pageStep >= 3;
		const working = inputVersions[viewedBranch];
		if (revisitingInput()) {
			const text = working?.base === snapshot.input ? working.text : snapshot.input;
			if (stagedInput.value !== text) stagedInput.value = text;
			if (editingInput() && (!inputCheck || inputCheck.text !== text)) stageInput();
		}
		reviewTree.render(snapshot, pageStep === 3, !!pending);
		const readyCopy = $('copy-ready-prompt'), copyStatus = $('copy-ready-status');
		if (readyCopyVersion !== snapshot.version) readyCopyVersion = undefined;
		readyCopy.hidden = !readyToCopy();
		readyCopy.disabled = !!pending || reviewTree.editing() || readyCopyVersion !== undefined;
		copyStatus.hidden = readyCopy.hidden || readyCopyResult?.version !== snapshot.version;
		if (!copyStatus.hidden) {
			const {ok, saved, saveFailed, stale} = readyCopyResult;
			copyStatus.textContent = ok ? (saved ? 'Saved and copied.' : 'Copied.')
				: saved ? 'Saved. Clipboard copy failed.' : saveFailed ? 'Could not save the prompt.'
					: stale ? 'The prompt changed. Review it before copying again.' : 'Could not copy the prompt.';
		}
		if (rewrite) {
			const local = currentWording();
			if (local && local.wording === rewrite.confirmed) removeWording(local);
			const wording = displayedWording();
			if (rewriteText.value !== wording && rewriteText.value !== wording.replace(/\r\n?/g, '\n')) rewriteText.value = wording;
			rewriteText.readOnly = rewrite.confirmed !== undefined;
		}
		$('review').hidden = pageStep > 2;
		$('review').title = pageStep === 2 ? 'Continue with reviewed wording' : 'Review suggested edits';
		$('check-mapping').hidden = pageStep !== 3 || phase !== 'proposal' ||
			(snapshot.clarificationEnabled && !snapshot.clarification?.mapping);
		$('mapping-back').hidden = pageStep !== 4;
		$('retry-mapping').hidden = pageStep !== 4 || mapping?.status !== 'failed';
		$('retry').hidden = pageStep === 2 || (editingInput() ? inputCheck?.entryStatus !== 'failed' :
			batch?.status !== 'failed' && snapshot.entryStatus !== 'failed');
		const statuses = { 'checking-harper': 'Checking text…', rewriting: 'Rewriting…' };
		const notice = snapshot.notice === 'Wording confirmed.' ? '' : snapshot.notice;
		$('notice').textContent = editingInput() ? inputCheck?.notice ?? '' : revisitingInput() ? '' :
			notice || (batch?.status === 'checking' && !batch.expanded ? 'Checking text…' : statuses[phase]) || '';
		document.querySelector('.workbench').dataset.mode = phase;
		document.querySelector('.sheet').setAttribute('aria-busy', String(batch?.status === 'checking' || phase === 'rewriting' || rewrite?.review.status === 'checking'));
		if (pageStep === 2 && !composing) {
			if (editor.value === snapshot.text && paintedVersion !== snapshot.version && batch?.status === 'ready') {
				drawIssues(batch.issues);
				paintedVersion = snapshot.version;
			} else if (source.textContent !== editor.value || (batch?.status === 'needs-text' && paintedVersion !== snapshot.version)) {
				drawIssues([]);
				paintedVersion = undefined;
			}
		} else {
			closeIssue();
			paintedVersion = undefined;
			$('signal').hidden = true;
		}
		historyPanel();
		controls();
		rememberPendingDraft();
		if (advance && modules.isDraft()) $('step-' + pageStep).focus();
		if (returnToFlag && !pending && batch?.status !== 'checking') {
			if (returnToFlag.branch === viewedBranch && returnToFlag.text === snapshot.text && pageStep === 2 &&
				(document.activeElement === document.body || panel.contains(document.activeElement) || source.contains(document.activeElement))) {
				const index = issues.findIndex(i => i.start >= returnToFlag.start);
				(marks[index < 0 ? marks.length - 1 : index]?.firstElementChild ?? source).focus();
			}
			returnToFlag = undefined;
		}
		flushChoice();
		if (actionMenu && !menuIsCurrent()) closeActionMenu();
	}
	function stageInput(action, fields = {}) {
		const text = stagedInput.value;
		inputCheck = {id: ++previewId, text, action};
		vscode.postMessage({type: 'stage-input', id: previewId, branch: viewedBranch, base: snapshot.input, text, action, ...fields});
		controls();
	}
	function saveInput(text) {
		inputVersions = {...inputVersions};
		if (text === snapshot.input) delete inputVersions[viewedBranch];
		else inputVersions[viewedBranch] = {base: snapshot.input, text, key: crypto.randomUUID()};
		rememberPendingDraft();
	}
	stagedInput.addEventListener('input', e => {
		saveInput(stagedInput.value);
		if (!e.isComposing) stageInput();
	});
	stagedInput.addEventListener('compositionend', () => stageInput());
	function flushDraft() {
		if (pending || composing || !snapshot) return;
		if (localBase !== undefined && editor.value !== snapshot.text) {
			if (!archiveEdit && snapshot.text === localBase && snapshot.history.activeBranch === localBranch) {
				send('edit', {text: editor.value});
				return;
			}
			// Follow the shared revision. Keep any unsent local text in this view's history.
			if (!recoveredEdits.some(copy => copy.text === editor.value && copy.base === localBase)) {
				recoveredEdits = [{text: editor.value, base: localBase}, ...recoveredEdits];
			}
			editor.value = snapshot.text;
		}
		localBase = undefined;
		localBranch = undefined;
		archiveEdit = false;
		retriedEdit = false;
	}
	window.addEventListener('message', ({data}) => {
		if (data?.panel) modules.initialize(data.panel);
		if (modules.receive(data)) return;
		if (data?.type === 'action-list' || data?.type === 'wording-timeline') {
			if (actionMenu?.token !== data.token || !menuIsCurrent()) return;
			if (data.type === 'action-list') drawActions(data.entries);
			else {
				const copy = currentWording();
				wordingDrafts = wordingDrafts.map(item => item === copy ? {...item, undo: data.line.past, redo: data.line.future, wording: data.line.current} : item);
				closeActionMenu(); render();
			}
			return;
		}
		if (data?.type === 'copy-result') {
			if (data.ready) {
				if (data.version === readyCopyVersion) {
					readyCopyVersion = undefined; readyCopyResult = data; render();
				}
			} else updateMapping(data);
			return;
		}
		if (data?.type === 'input-highlights') { reviewTree.highlights(data); return; }
		if (data?.type === 'clarification-files' || data?.type === 'clarification-resource-error') { clarification.receive(data); return; }
		if (data?.type === 'input-preview') {
			if (!snapshot || data.id !== inputCheck?.id || data.branch !== viewedBranch || data.base !== snapshot.input) return;
			if (inputCheck.action && data.text !== stagedInput.value) {
				stagedInput.value = data.text;
				saveInput(data.text);
			}
			if (data.text === stagedInput.value) {
				inputCheck = data;
				render();
			}
			return;
		}
		if (data?.type !== 'snapshot' || !Number.isSafeInteger(data.version)) return;
		const action = pending && data.requestId === pending.requestId ? pending : undefined;
		if (!action && snapshot && data.version <= snapshot.version) return;
		if (action) {
			if (action.type === 'set-draft-tags') tags.acknowledge(data.status);
			reviewTree.result(action.type,data.status);
			if (action.type === 'choose' && data.status !== 'accepted') closeIssue();
			clearTimeout(ackTimer);
			pending = undefined;
		}
		if (!snapshot || data.version >= snapshot.version) {
		const handledNotice = action?.type === 'submit-clarification' || (action?.type === 'edit' && data.status === 'stale');
		snapshot = handledNotice ? {...data, notice: undefined} : data;
		}
		clarification.result(action, data);
		if (snapshot.clarification) {
			const {session, questionIds} = snapshot.clarification;
			const active = new Set(questionIds.map(id => session + ':' + id));
			for (const key of Object.keys(clarificationDrafts)) {
				if (key.startsWith(session + ':') && !active.has(key)) {
					clarificationDrafts = {...clarificationDrafts}; delete clarificationDrafts[key];
				}
			}
		}
		updateMapping({...snapshot, summary:snapshot.sections,
			proposalId:snapshot.rewrite?.id, wording:snapshot.rewrite?.checkedWording,
			result:action && ['save-mapping','answer-question'].includes(action.type) ? data : undefined});
		if (recoveredDraft !== undefined) {
			editor.value = recoveredDraft;
			recoveredDraft = undefined;
			localBase = typeof saved?.draftBase === 'string' ? saved.draftBase : snapshot.text;
			localBranch = saved?.draftBranch ?? snapshot.history.activeBranch;
			// Older webviews saved only the text, so the original base can be unknown.
			archiveEdit = typeof saved?.draftBase !== 'string' && snapshot.version !== 0;
		}
		if (action?.type === 'edit') {
			if (data.status === 'accepted') {
				// A newer worker snapshot may already follow this accepted edit. Preserve only actual type-ahead.
				localBase = !composing && editor.value === action.text ? undefined : action.text;
				localBranch = data.history.activeBranch;
				retriedEdit = false;
			} else if (data.status === 'stale' && !retriedEdit && snapshot.version > action.version) {
				retriedEdit = true;
			} else {
				archiveEdit = true;
			}
		}
		// A view can disappear after opening a local fork but before its acknowledgement arrives.
		const openedCopies = new Set([snapshot.history.activeCopyKey, ...snapshot.history.branches.map(branch => branch.copyKey)]);
		for (const [branch, input] of Object.entries(inputVersions)) {
			if (input.key && openedCopies.has(input.key)) {
				inputVersions = {...inputVersions};
				delete inputVersions[branch];
			}
		}
		for (const copy of [...recoveredEdits, ...wordingDrafts]) {
			if (copy.key && openedCopies.has(copy.key)) discardCopy(copy);
		}
		if (data.status === 'accepted' && action?.type === 'restore' && inputVersions[viewedBranch]) {
			inputVersions = {...inputVersions};
			delete inputVersions[viewedBranch];
			inputCheck = undefined;
		}
		if (data.status === 'accepted' && action?.type === 'back-from-mapping' && !snapshot.mapping) pageStep = action.backStep ?? 3;
		if (!composing && localBase === undefined && editor.value !== snapshot.text) editor.value = snapshot.text;
		flushDraft();
		rememberPendingDraft();
		render();
		if (data.status === 'accepted' && ['restore', 'open-branch', 'open-copy'].includes(action?.type)) {
			visibleEditor()?.focus();
		}
		if (data.status === 'accepted' && action?.type === 'back-from-mapping') visibleEditor()?.focus();
	});
	function review() {
		if ($('review').disabled || $('review').hidden) return;
		if (pageStep === 2) {
			if (snapshot.rewrite) return selectStep(3);
			return send(snapshot.batch?.status === 'failed' ? 'retry-text-review' : 'use-reviewed-wording');
		}
		if (!revisitingInput()) return send('start-review');
		if (!editingInput()) {
			const clean = snapshot.batch?.status === 'ready' && snapshot.batch.issues.length === 0;
			return selectStep(clean && snapshot.rewrite ? 3 : 2);
		}
		archiveRequest = {version: snapshot.version, text: stagedInput.value, key: inputVersions[viewedBranch].key, previewId: inputCheck.id};
		archiveDialog.showModal();
	}
	function input() {
		if (!snapshot) return;
		localBase ??= snapshot.text;
		localBranch ??= snapshot.history.activeBranch;
		closeIssue();
		$('notice').textContent = '';
		flushDraft();
		rememberPendingDraft();
		controls();
	}
	editor.addEventListener('input', input);
	function sourceInput() {
		editor.value = source.textContent;
		input();
	}
	source.addEventListener('input', sourceInput);
	for (const surface of [editor, source]) {
		surface.addEventListener('compositionstart', () => {
			composing = true;
			localBase ??= snapshot?.text;
			localBranch ??= snapshot?.history.activeBranch;
			closeIssue();
			controls();
		});
		surface.addEventListener('compositionend', () => {
			composing = false;
			if (surface === source) sourceInput(); else input();
			render();
		});
	}
	function insertPlain(text) {
		const selection = window.getSelection();
		if (!selection.rangeCount || !source.contains(selection.anchorNode) || !source.contains(selection.focusNode)) return;
		const range = selection.getRangeAt(0);
		range.deleteContents();
		const node = document.createTextNode(text);
		range.insertNode(node);
		selection.collapse(node, text.length);
		sourceInput();
	}
	source.addEventListener('beforeinput', event => {
		if (event.isComposing || !['insertParagraph', 'insertLineBreak'].includes(event.inputType)) return;
		event.preventDefault();
		insertPlain('\n');
	});
	source.addEventListener('paste', event => {
		event.preventDefault();
		insertPlain(event.clipboardData.getData('text/plain').replace(/\r\n?/g, '\n'));
	});
	source.addEventListener('pointermove', event => {
		if (pinned || event.buttons || event.pointerType === 'touch') return;
		const node = event.target.closest('[data-issue]');
		clearTimeout(hoverTimer);
		if (node) {
			clearTimeout(closeTimer);
			hoverTimer = setTimeout(() => openIssue(Number(node.dataset.issue), false, event.clientY), 130);
		} else if (active >= 0) delayClose();
	});
	function delayClose() {
		clearTimeout(hoverTimer);
		clearTimeout(closeTimer);
		if (!pinned) closeTimer = setTimeout(closeIssue, 180);
	}
	source.addEventListener('pointerleave', delayClose);
	source.addEventListener('click', event => {
		const node = event.target.closest('[data-issue]');
		if (node && window.getSelection?.()?.isCollapsed !== false) openIssue(Number(node.dataset.issue), true, event.clientY);
		else closeIssue();
	});
	panel.addEventListener('pointerenter', () => clearTimeout(closeTimer));
	panel.addEventListener('pointerleave', delayClose);
	panel.addEventListener('focusin', () => { pinned = true; clearTimeout(closeTimer); });
	panel.addEventListener('pointerdown', () => { pinned = true; });
	document.addEventListener('pointerdown', event => {
		if (actionMenu && !actionPanel.contains(event.target)) closeActionMenu();
		if (opened(panel) && !panel.contains(event.target) && !source.contains(event.target) && !warning.contains(event.target)) closeIssue();
	});
	function focusFlag(index) {
		if (!marks[index]) return false;
		closeIssue();
		marks[index].firstElementChild.focus();
		return true;
	}
	function focusOverlay() {
		($('previous').disabled ? $('custom') : $('previous')).focus();
	}
	document.addEventListener('keydown', event => {
		if (!modules.isDraft() || event.isComposing || composing || archiveDialog.open || event.altKey || event.metaKey) return;
		const key = event.key;
		const horizontal = key === 'ArrowLeft' ? -1 : key === 'ArrowRight' ? 1 : 0;
		if (event.ctrlKey) {
			if (horizontal && !event.shiftKey && reached) {
				event.preventDefault(); selectStep(Math.max(1, Math.min(reached, pageStep + horizontal)));
			}
			return;
		}
		if (opened(actionPanel)) return;
		const flag = marks.indexOf(document.activeElement?.closest('[data-issue]') ?? event.target.closest?.('[data-issue]'));
		const inside = opened(panel) && (panel.contains(event.target) || pinned);
		if (opened(panel) && key === 'Escape') {
			event.preventDefault();
			if (!$('correction').hidden) { setCustom(false); fitRibbon(); $('custom').focus(); }
			else { const index = active; focusFlag(index); }
			return;
		}
		if (inside && $('correction').hidden && event.shiftKey && horizontal) {
			event.preventDefault(); cycleCandidate(horizontal); return;
		}
		if (inside && key === 'Tab') {
			const stops = [...panel.querySelectorAll('button:not(:disabled), input')].filter(el => el.tabIndex >= 0 && !el.closest('[hidden]'));
			const here = stops.indexOf(document.activeElement);
			event.preventDefault(); stops[here < 0 ? (event.shiftKey ? stops.length - 1 : 0) : (here + (event.shiftKey ? -1 : 1) + stops.length) % stops.length]?.focus();
			return;
		}
		if (inside && horizontal && panel.contains(event.target) && event.target !== replacement) {
			event.preventDefault(); cycleCandidate(horizontal); return;
		}
		if (pageStep !== 2 || !marks.length) return;
		if (flag >= 0 && (key === 'Enter' || key === ' ')) {
			event.preventDefault(); openIssue(flag, true); focusOverlay(); return;
		}
		if (flag >= 0 && (horizontal || key === 'ArrowUp' || key === 'ArrowDown' || key === 'Tab')) {
			const offset = horizontal || (key === 'ArrowUp' || event.shiftKey ? -1 : 1);
			if (focusFlag(flag + offset)) event.preventDefault();
		}
	});
	function reposition() {
		if (active >= 0) { fitRibbon(); locateActive(false); }
	}
	source.addEventListener('scroll', reposition);
	window.addEventListener('scroll', reposition);
	window.addEventListener('resize', reposition);
	const observer = new ResizeObserver(reposition);
	observer.observe(source); observer.observe(panel);
	warning.addEventListener('click', event => {
		const index = active >= 0 && issues[active]?.replacement === undefined ? active : issues.findIndex(issue => issue.replacement === undefined);
		openIssue(index, true);
		if (!event.detail && opened(panel)) focusOverlay();
	});
	$('previous').addEventListener('click', () => cycleCandidate(-1));
	$('next').addEventListener('click', () => cycleCandidate(1));
	$('apply-candidate').addEventListener('click', () => {
		const issue = issues[active], replacement = candidates[selected];
		if (issue && replacement !== undefined) {
			applyWordAction('choose', {start: issue.start, end: issue.end, replacement, apply: true});
		}
	});
	$('custom').addEventListener('click', () => setCustom(true));
	$('back').addEventListener('click', () => { setCustom(false); fitRibbon(); $('custom').focus(); });
	function reportClippedReplacement() {
		const issue = issues[active];
		if (reportedClipping || !issue || !snapshot) return;
		reportedClipping = true;
		vscode.postMessage({type: 'replacement-clipped', version: snapshot.version, revision: snapshot.revision,
			start: issue.start, end: issue.end});
	}
	function updateReplacement(raw = replacement.value) {
		const issue = issues[active];
		const input = raw.replace(/^[\s\p{White_Space}]+/u, '');
		const boundary = input.search(replacementWhitespace);
		const first = boundary < 0 ? input : input.slice(0, boundary);
		clippedReplacement = boundary >= 0 && /^[A-Za-z]+$/.test(first);
		if (clippedReplacement && input.slice(boundary).replace(/[\s\p{White_Space}]/gu, '')) reportClippedReplacement();
		const value = clippedReplacement ? first : input;
		if (replacement.value !== value) replacement.value = value;
		$('replace').disabled = replacementComposing || !issue || !/^[A-Za-z]+$/.test(value) ||
			value === editor.value.slice(issue.start, issue.end);
	}
	replacement.addEventListener('beforeinput', event => {
		if (event.isComposing || !clippedReplacement || !event.inputType?.startsWith('insert') ||
			replacement.selectionStart !== replacement.value.length || replacement.selectionEnd !== replacement.value.length) return;
		if (event.cancelable) {
			event.preventDefault();
			if (event.data && !replacementWhitespace.test(event.data)) reportClippedReplacement();
		}
	});
	replacement.addEventListener('paste', event => {
		if (!event.clipboardData) return;
		event.preventDefault();
		const text = event.clipboardData.getData('text/plain');
		const {value, selectionStart, selectionEnd} = replacement;
		if (clippedReplacement && selectionStart === value.length && selectionEnd === value.length) {
			if (text.replace(/[\s\p{White_Space}]/gu, '')) reportClippedReplacement();
			return;
		}
		updateReplacement(value.slice(0, selectionStart) + text + value.slice(selectionEnd));
	});
	replacement.addEventListener('compositionstart', () => { replacementComposing = true; $('replace').disabled = true; });
	replacement.addEventListener('compositionend', () => { replacementComposing = false; updateReplacement(); });
	replacement.addEventListener('input', event => { if (!event.isComposing && !replacementComposing) updateReplacement(); });
	$('correction').addEventListener('submit', event => {
		event.preventDefault();
		const issue = issues[active];
		if (issue && !$('correction').hidden && !$('replace').disabled && /^[A-Za-z]+$/.test(replacement.value)) {
			applyWordAction('choose', {start: issue.start, end: issue.end, replacement: replacement.value, custom: true});
		}
	});
	for (const [id, scope] of [['keep-once', 'occurrence'], ['keep-term', 'term']]) {
		$(id).addEventListener('click', () => {
			const issue = issues[active];
			if (issue) applyWordAction('validate', {start: issue.start, end: issue.end, scope});
		});
	}
	$('review').addEventListener('click', review);
	$('retry').addEventListener('click', () => editingInput() ? stageInput('retry-text-review') : send('retry-text-review'));
	$('check-mapping').addEventListener('click', () => {
		if ($('check-mapping').disabled) return;
		previewRequested = true;
		if (snapshot.mapping && snapshot.rewrite.checkedWording === displayedWording() && snapshot.mapping.status !== 'failed') {
			pageStep = 4; render(); return;
		}
		send('check-mapping', {proposalId: snapshot.rewrite.id, wording: displayedWording()});
	});
	$('retry-mapping').addEventListener('click', () => send('check-mapping', {proposalId: snapshot.rewrite.id, wording: snapshot.rewrite.checkedWording}));
	$('mapping-back').addEventListener('click', () => selectStep(3));
	$('cancel-archive').addEventListener('click', () => archiveDialog.close());
	$('archive-input').addEventListener('click', () => {
		const request = archiveRequest;
		archiveDialog.close();
		if (request && request.version === snapshot.version && request.text === stagedInput.value && inputCheck?.canNext) {
			send('archive-input', {text: request.text, key: request.key, previewId: request.previewId});
		}
	});
	archiveDialog.addEventListener('close', () => { if (!archiveDialog.open) archiveRequest = undefined; });
	function saveWording(action, exact) {
		if (snapshot.phase !== 'proposal') return;
		const proposal = snapshot.rewrite;
		const prior = currentWording();
		const before = prior?.wording ?? proposal.checkedWording ?? proposal.proposed;
		const undo = [...(prior?.undo ?? [])], redo = [...(prior?.redo ?? [])];
		let wording;
		if (action === 'undo' && undo.length) { redo.push(before); wording = undo.pop(); rewriteText.value = wording; }
		else if (action === 'redo' && redo.length) { undo.push(before); wording = redo.pop(); rewriteText.value = wording; }
		else if (before !== (exact ?? rewriteText.value)) { undo.push(before); redo.length = 0; wording = exact ?? rewriteText.value; }
		else return;
		wordingDrafts = wordingDrafts.filter(item => !sameProposal(item, proposal));
		wordingDrafts.push({id: proposal.id, source: proposal.text, proposed: proposal.proposed, wording, undo, redo});
		rememberPendingDraft();
		controls();
	}
	rewriteText.addEventListener('input', () => saveWording());
	function history(action) {
		if ($(action).disabled) return;
		if (opened($('history-panel'))) $('history-panel').hidePopover();
		if (action !== 'restore' && revisitingInput()) return stageInput(action);
		if (action !== 'restore' && pageStep === 3) return saveWording(action);
		send(action);
	}
	function menuIsCurrent() {
		return actionMenu && actionMenu.step === pageStep && actionMenu.version === snapshot.version &&
			actionMenu.branch === viewedBranch && actionMenu.input === inputCheck && actionMenu.copy === currentWording();
	}
	function closeActionMenu() {
		actionMenu = undefined;
		if (opened(actionPanel)) actionPanel.hidePopover();
	}
	function showActions(side) {
		if ($(side).disabled || pending || !snapshot) return;
		closeIssue();
		if (opened($('history-panel'))) $('history-panel').hidePopover();
		const copy = currentWording(), token = ++menuToken;
		actionMenu = {side, token, step: pageStep, version: snapshot.version, branch: viewedBranch, input: inputCheck, copy};
		vscode.postMessage({type: 'action-list', side, token,
			version: revisitingInput() ? inputCheck.version : snapshot.version,
			previewId: revisitingInput() ? inputCheck.id : undefined,
			wording: pageStep === 3 && copy ? {past: copy.undo, current: copy.wording, future: copy.redo} : undefined});
	}
	function dropListed(index) {
		if (!menuIsCurrent()) { closeActionMenu(); return; }
		const {side, token, copy} = actionMenu;
		if (pageStep === 3) {
			vscode.postMessage({type: 'drop-wording-action', side, token, index,
				wording: {past: copy.undo, current: copy.wording, future: copy.redo}});
			return;
		}
		closeActionMenu();
		if (revisitingInput()) stageInput('drop-action', {side, index, historyVersion: inputCheck.version});
		else send('drop-action', {side, index});
	}
	function drawActions(entries) {
		if (!entries.length) { closeActionMenu(); return; }
		const side = actionMenu.side;
		actionPanel.setAttribute('aria-label', side === 'undo' ? 'Undo actions' : 'Redo actions');
		const rows = entries.map((title, index) => {
			const row = document.createElement('li'), button = document.createElement('button');
			const label = document.createElement('span'), glyph = document.createElement('span');
			label.className = 'action-label'; label.textContent = title;
			glyph.className = 'delete-glyph codicon codicon-close'; glyph.setAttribute('aria-hidden','true');
			button.type = 'button'; button.title = title; button.setAttribute('aria-label', 'Remove action: ' + title);
			button.append(label, glyph); button.addEventListener('click', () => dropListed(index));
			row.append(button);
			return row;
		});
		$('action-items').replaceChildren(...rows);
		if (!opened(actionPanel)) actionPanel.showPopover();
		const anchor = $(side).getBoundingClientRect(), box = actionPanel.getBoundingClientRect();
		actionPanel.style.left = Math.max(5, Math.min(innerWidth - box.width - 5, anchor.right - box.width)) + 'px';
		actionPanel.style.top = (anchor.bottom + box.height + 5 <= innerHeight ? anchor.bottom + 4 : Math.max(5, anchor.top - box.height - 4)) + 'px';
		rows[0].firstElementChild.focus();
	}
	actionPanel.addEventListener('focusout', e => { if (e.relatedTarget && !actionPanel.contains(e.relatedTarget)) closeActionMenu(); });
	actionPanel.addEventListener('beforetoggle', e => { if (e.newState === 'closed') actionMenu = undefined; });
	actionPanel.addEventListener('keydown', e => {
		const buttons = [...$('action-items').querySelectorAll('button')], index = buttons.indexOf(document.activeElement);
		if (e.key === 'Escape' && actionMenu) {
			e.preventDefault(); const button = $(actionMenu.side); closeActionMenu(); button.focus(); return;
		}
		if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
			e.preventDefault(); buttons[(index + (e.key === 'ArrowUp' ? -1 : 1) + buttons.length) % buttons.length]?.focus();
		}
	});
	for (const side of ['undo', 'redo']) {
		const button = $(side);
		let timer, held = false;
		const cancel = () => clearTimeout(timer);
		button.addEventListener('pointerdown', e => {
			cancel(); held = false;
			if (e.button === 0) timer = setTimeout(() => { held = true; showActions(side); }, 450);
		});
		for (const event of ['pointerup','pointerleave','pointercancel']) button.addEventListener(event, cancel);
		window.addEventListener('blur', cancel);
		button.addEventListener('contextmenu', e => { e.preventDefault(); cancel(); showActions(side); });
		button.addEventListener('keydown', e => {
			if (e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey)) { e.preventDefault(); showActions(side); }
		});
		button.addEventListener('click', e => {
			if (held && e.detail !== 0) { held = false; return; }
			closeActionMenu(); history(side);
		});
	}
	$('restore').addEventListener('click', () => history('restore'));
	$('history-panel').addEventListener('beforetoggle', event => {
		if (event.newState === 'open') { closeIssue(); closeActionMenu(); }
	});
	document.querySelector('.writing').addEventListener('beforeinput', e => {
		if (mappingReview.contains(e.target) || $('tree-mappings').contains(e.target) || $('tree-clarification').contains(e.target) ||
			!['historyUndo','historyRedo'].includes(e.inputType)) return;
		e.preventDefault();
		history(e.inputType === 'historyUndo' ? 'undo' : 'redo');
	});
	document.querySelector('.writing').addEventListener('keydown', e => {
		if (mappingReview.contains(e.target) || $('tree-mappings').contains(e.target) || $('tree-clarification').contains(e.target) ||
			!(e.metaKey || e.ctrlKey) || e.altKey || e.isComposing) return;
		const key = e.key.toLowerCase();
		if (key === 'enter' && !$('review').hidden) { e.preventDefault(); review(); }
		else if (key === 'z' || (key === 'y' && e.ctrlKey)) {
			e.preventDefault();
			history(key === 'y' || e.shiftKey ? 'redo' : 'undo');
		}
	});
	send('sync');
})();
