/* Navigation lives in the sidebar. VS Code renders the two-level settings tree. */
function createReviewModules(vscode, getInfo, focusDraft, closeTools) {
	const $ = id => document.getElementById(id);
	const query = $('log-query'), explorer = $('log-explorer'), runs = $('log-runs');
	const info = $('info-panel'), copy = $('copy-id');
	const homeStatus = $('home-status'), newPrompt = $('home-new-prompt');
	let displayedLastPrompt;
	let page = 'draft', settings = {enabled: false, source: 'none', fontSize: 0};
	let id, token = 0, oldest, copyTimer, settingPending = false, initialized = false;
	const send = (type, fields = {}) => vscode.postMessage({type, ...fields});
	const recents = createPromptRecents(send);
	const recording = () => settings.enabled && settings.source === 'markov';
	function updateInfo() {
		const value = getInfo();
		if (!value) return;
		$('info-step').textContent = value.step + ' · ' + value.name;
		for (const key of ['variant','undo','redo']) $('info-' + key).textContent = String(value[key]);
		$('info-id').textContent = value.id ?? '…';
		$('info-id').disabled = !value.id || !settings.enabled;
		$('info-id').title = $('info-id').disabled ? '' : 'Open step logs';
		$('info-id').setAttribute('aria-label', settings.enabled ? 'Open step logs' : 'Step ID');
		copy.disabled = !value.id;
	}
	info.addEventListener('beforetoggle', e => {
		if (e.newState === 'open') { closeTools(); updateInfo(); }
		info.scrollTop = 0;
	});
	$('info-id').addEventListener('click', () => { if (settings.enabled) send('panel-page',{page:'logs', id:getInfo()?.id}); });
	copy.addEventListener('click', () => send('copy-step-id', {id:getInfo()?.id}));
	function resetLogs() {
		token++; id = undefined; oldest = undefined;
		explorer.hidden = true; $('log-more').hidden = true;
		runs.replaceChildren(); $('log-status').textContent = '';
	}
	function lookup(value) {
		resetLogs();
		query.value = value;
		if (!/^(?:[\w-]{22}|[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12})$/i.test(value)) return;
		id = value;
		if (recording()) send('log-list',{id,token});
	}
	query.addEventListener('input', resetLogs);
	query.addEventListener('paste', e => {
		e.preventDefault();
		lookup(e.clipboardData.getData('text/plain').trim());
	});
	$('log-more').addEventListener('click', () => {
		if (oldest && id) { $('log-more').disabled = true; send('log-list',{id,token,before:oldest}); }
	});
	function updateLogButton() {
		$('open-logs').hidden = !settings.enabled || !$('settings-page').hidden;
	}
	function showHome({canStartProjectPrompt, hasRecentPrompts, lastPrompt, saveWarning}) {
		displayedLastPrompt = lastPrompt;
		homeStatus.textContent = saveWarning ?? '';
		$('home-last').hidden = !lastPrompt;
		$('home-recents').hidden = !hasRecentPrompts;
		if (lastPrompt) {
			$('home-last-title').textContent = lastPrompt.title;
			const metadata = [lastPrompt.project];
			const date = new Date(lastPrompt.updatedAt);
			if (!Number.isNaN(date.getTime())) {
				const today = date.toDateString() === new Date().toDateString();
				metadata.push(today ? 'Today' : date.toLocaleDateString(undefined, {dateStyle: 'medium'}));
			}
			$('home-last-meta').textContent = metadata.filter(Boolean).join(' · ');
		}
		$('home-new-label').textContent = canStartProjectPrompt ? 'New project prompt' : 'Initialize Project';
		newPrompt.disabled = false;
	}
	function navigate({page: next, id: stepId, key, resume}, focus = true) {
		if (info.matches(':popover-open')) info.hidePopover();
		if ($('history-panel').matches(':popover-open')) $('history-panel').hidePopover();
		closeTools(); resetLogs();
		if (page === 'recents') recents.leave();
		page = next;
		const detail = page === 'editor-settings' || page === 'logging-settings';
		document.querySelector('.sheet').hidden = page !== 'draft';
		$('home-page').hidden = page !== 'home';
		$('recents-page').hidden = page !== 'recents';
		$('settings-page').hidden = !detail;
		updateLogButton();
		$('logs-page').hidden = page !== 'logs';
		for (const [button, selected] of [['focus-home',page === 'home'],['focus-recents',page === 'recents'],['focus-draft',page === 'draft'],['open-settings',detail],['open-logs',page === 'logs']]) {
			if (selected) $(button).setAttribute('aria-current','page'); else $(button).removeAttribute('aria-current');
		}
		if (page === 'recents') recents.open(focus);
		if (page === 'home') {
			homeStatus.textContent = '';
			$('home-last').hidden = $('home-recents').hidden = newPrompt.disabled = true;
			if (focus) $('focus-home').focus();
			send('home-state');
		}
		if (page === 'logs') { query.value = ''; if (stepId) lookup(stepId); if (focus) query.focus(); }
		if (detail) {
			const logging = page === 'logging-settings';
			$('settings-heading').textContent = logging ? 'Logging' : 'Editor';
			$('logging-fields').hidden = !logging; $('font-field').hidden = logging;
			$('settings-status').textContent = '';
			const control = key && $('settings-page').querySelector('[data-setting="'+key+'"]');
			if (control?.disabled) {
				control.parentElement.tabIndex = -1;
				control.parentElement.focus();
			} else if (control) control.focus();
			else if (focus) $('settings-back').focus();
		}
		if (page === 'draft' && focus) focusDraft(resume);
	}
	$('focus-home').addEventListener('click', () => {
		if (page === 'home') navigate({page: 'home'}, false);
		else send('panel-page', {page: 'home'});
	});
	$('focus-recents').addEventListener('click', () => {
		if (page === 'recents') send('recents-state');
		else send('panel-page', {page: 'recents'});
	});
	for (const [button, action] of [['home-open-last', 'last'], ['home-new-prompt', 'new'], ['home-scratch', 'scratch'], ['home-recents', 'recents']]) {
		$(button).addEventListener('click', () => {
			homeStatus.textContent = '';
			send('home-action', {action, ...(action === 'last' && displayedLastPrompt &&
				{projectId: displayedLastPrompt.projectId, promptId: displayedLastPrompt.promptId})});
		});
	}
	$('focus-draft').addEventListener('click', () => page === 'draft' ? focusDraft() : send('panel-page',{page:'draft'}));
	$('open-project-context').addEventListener('click', () => send('open-project-context'));
	$('open-logs').addEventListener('click', () => send('panel-page',{page:'logs'}));
	for (const button of ['open-settings','settings-back']) $(button).addEventListener('click', () => send('open-settings'));
	function applySettings(next) {
		const refresh = next.enabled !== settings.enabled || next.source !== settings.source;
		settings = next;
		updateLogButton(); updateInfo();
		$('logging-enabled').checked = settings.enabled;
		$('logging-enabled').disabled = $('editor-size').disabled = settingPending;
		$('logging-source').value = settings.enabled ? settings.source : 'none';
		$('logging-source').disabled = settingPending || !settings.enabled;
		$('editor-size').value = settings.fontSize || '';
		if (settings.fontSize) document.documentElement.style.setProperty('--review-font-size',settings.fontSize+'px');
		else document.documentElement.style.removeProperty('--review-font-size');
		if (refresh && id && page === 'logs') lookup(id);
	}
	function changeSetting(key,value) {
		settingPending = true;
		$('logging-enabled').disabled = $('logging-source').disabled = $('editor-size').disabled = true;
		$('settings-status').textContent = '';
		send('panel-setting',{key,value});
	}
	$('logging-enabled').addEventListener('change', e => changeSetting('logging.enabled',e.target.checked));
	$('logging-source').addEventListener('change', e => changeSetting('logging.source',e.target.value));
	$('editor-size').addEventListener('change', e => {
		if (e.target.validity.valid) changeSetting('editor.fontSize',Number(e.target.value));
		else e.target.reportValidity();
	});
	function row(entry) {
		const details = document.createElement('details'), summary = document.createElement('summary');
		const meta = document.createElement('span'), body = document.createElement('div');
		details.dataset.seq = String(entry.seq);
		summary.textContent = entry.pass + ' · ' + entry.flags + (entry.flags === 1 ? ' flag' : ' flags');
		meta.className = 'run-meta';
		meta.textContent = new Date(entry.time).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit',second:'2-digit'});
		summary.append(meta); body.className = 'run-detail'; details.append(summary,body);
		details.addEventListener('toggle', () => {
			if (details.open && id) { body.textContent = 'Loading…'; send('log-read',{id,token,seq:entry.seq}); }
			else body.replaceChildren();
		});
		return details;
	}
	function showRun(seq,run) {
		const details = runs.querySelector('[data-seq="'+seq+'"]');
		if (!details?.open) return;
		const body = details.lastElementChild;
		if (!run) { body.replaceChildren(); return; }
		const result = document.createElement('p');
		result.textContent = run.flags.length ? run.flags.map(word => word.text+' ('+word.start+'–'+word.end+')').join(', ') : 'No flagged words.';
		const raw = document.createElement('details'), summary = document.createElement('summary'), pre = document.createElement('pre');
		summary.textContent = 'Run data'; raw.append(summary,pre);
		raw.addEventListener('toggle', () => { pre.textContent = raw.open ? JSON.stringify(run,null,2) : ''; });
		body.replaceChildren(result,raw);
	}
	return {
		isDraft: () => page === 'draft', updateInfo,
		initialize(state) {
			applySettings(state.settings);
			if (page !== state.page || (!initialized && (state.id || state.key))) navigate(state,false);
			else if (page === 'home') send('home-state');
			else if (page === 'recents') send('recents-state');
			initialized = true;
		},
		receive(data) {
			switch (data?.type) {
				case 'panel-page': navigate(data); break;
				case 'home-state': if (page === 'home') showHome(data.state); break;
				case 'recents-state': if (page === 'recents') recents.update(data.rows, data.saveWarning, data.background); break;
				case 'recents-result': if (page === 'recents') recents.finish(data); break;
				case 'panel-settings': settingPending = false; applySettings(data.settings); break;
				case 'id-copied':
					if (getInfo()?.id === data.id) {
						copy.title = 'Copied'; copy.firstElementChild.className = 'codicon codicon-check';
						clearTimeout(copyTimer); copyTimer = setTimeout(() => { copy.title = 'Copy step ID'; copy.firstElementChild.className = 'codicon codicon-copy'; },1200);
					}
					break;
				case 'log-invalid': if (data.token === token) resetLogs(); break;
				case 'log-list':
					if (!id || data.token !== token || !recording()) break;
					id = data.id;
					runs.append(...data.rows.map(row)); oldest = data.rows.at(-1)?.seq;
					explorer.hidden = !runs.children.length;
					$('log-status').textContent = '';
					$('log-more').hidden = !data.more; $('log-more').disabled = false; break;
				case 'log-read': if (id && data.token === token && recording()) showRun(data.seq,data.run); break;
				case 'panel-error':
					if (data.action === 'panel-setting') { settingPending = false; applySettings(data.settings); $('settings-status').textContent = 'Could not save setting.'; }
					else if (page === 'home' && data.action === 'home-state') {
						newPrompt.disabled = false;
						homeStatus.textContent = 'Could not load Home.';
					}
					else if (page === 'home' && data.action === 'home-action') homeStatus.textContent = 'Could not complete this action.';
					else if (page === 'recents' && data.action === 'recents-state') recents.error('Could not load Recents.');
					else if (id && data.token === token) { $('log-status').textContent = 'Could not read this log.'; $('log-more').disabled = false; }
					else if (data.action === 'copy-step-id') copy.title = 'Could not copy ID';
					break;
				default: return false;
			}
			return true;
		}
	};
}
