function createPromptRecents(send) {
	const $ = id => document.getElementById(id);
	const page = $('recents-page'), space = $('recents-list-space');
	const heading = $('recents-heading'), list = $('recents-list'), status = $('recents-status');
	const allButton = $('recents-all'), back = $('recents-back'), pagination = $('recents-pagination');
	const previous = $('recents-prev'), next = $('recents-next'), range = $('recents-range');
	const menu = $('recents-menu'), menuItems = [...menu.querySelectorAll('[role="menuitem"]')];
	const summary = $('recents-summary'), summaryBody = $('recents-summary-body');
	const formatter = new Intl.DateTimeFormat(undefined, {dateStyle: 'medium', timeStyle: 'short'});
	const recentLimit = 5;
	let rows = [], capacity = 6, pageNumber = 0, all = false;
	let nextToken = 0, pending;
	let anchor, selected;

	function element(tag, className, text) {
		const node = document.createElement(tag);
		if (className) node.className = className;
		if (text !== undefined) node.textContent = text;
		return node;
	}

	function dayColor(date) {
		// Convert the local calendar day to an ordinal so DST and page changes do not affect color.
		const day = Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / 86400000;
		return ((day % 7) + 7) % 7;
	}

	function closeMenu(restoreFocus = false) {
		if (!anchor) return;
		const button = anchor;
		anchor = selected = undefined;
		menu.hidePopover();
		button.setAttribute('aria-expanded', 'false');
		if (restoreFocus && button.isConnected) button.focus();
	}

	function openMenu(button, row, focusLast = false) {
		if (pending) return;
		if (anchor === button) { closeMenu(true); return; }
		closeMenu();
		anchor = button;
		selected = row;
		button.setAttribute('aria-expanded', 'true');
		menu.showPopover();
		const rect = button.getBoundingClientRect(), bounds = page.getBoundingClientRect();
		const menuWidth = menu.offsetWidth, menuHeight = menu.offsetHeight;
		menu.style.left = Math.max(bounds.left + 4, rect.right - menuWidth) + 'px';
		menu.style.top = Math.max(4, Math.min(rect.bottom + 2, innerHeight - menuHeight - 4)) + 'px';
		menuItems[focusLast ? menuItems.length - 1 : 0].focus();
	}

	function action(actionName, row) {
		if (pending) return;
		pending = ++nextToken;
		status.textContent = '';
		send('recents-action', {action: actionName, projectId: row.projectId, promptId: row.promptId, token: pending});
	}

	function makeRow(row) {
		const item = element('li', 'recents-row');
		const title = element('button', 'recents-title');
		title.type = 'button';
		title.title = row.title;
		title.append(element('span', undefined, row.title));
		title.addEventListener('click', () => action('continue', row));
		const clock = element('span', 'recents-clock');
		const date = new Date(row.updatedAt);
		if (Number.isFinite(date.getTime())) {
			clock.dataset.day = String(dayColor(date));
			clock.title = formatter.format(date);
			clock.setAttribute('role', 'img');
			clock.setAttribute('aria-label', 'Saved ' + clock.title);
		}
		clock.append(element('span'));
		clock.firstElementChild.setAttribute('aria-hidden', 'true');
		const more = element('button', 'recents-more');
		more.type = 'button';
		more.title = 'More actions';
		more.setAttribute('aria-label', 'Actions for ' + row.title);
		more.setAttribute('aria-haspopup', 'menu');
		more.setAttribute('aria-controls', menu.id);
		more.setAttribute('aria-expanded', 'false');
		const dots = element('span', undefined, '⋮');
		dots.setAttribute('aria-hidden', 'true');
		more.append(dots);
		more.addEventListener('click', () => openMenu(more, row));
		more.addEventListener('keydown', event => {
			if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
			event.preventDefault();
			openMenu(more, row, event.key === 'ArrowUp');
		});
		item.append(title, clock, more);
		return item;
	}

	function render(restoreFocus = false) {
		const focus = document.activeElement;
		const oldRow = focus?.closest('.recents-row');
		const oldIndex = oldRow ? [...list.children].indexOf(oldRow) : -1;
		const focusedMenu = focus?.classList.contains('recents-more');
		closeMenu();
		const count = all ? capacity : Math.min(recentLimit, capacity);
		pageNumber = all ? Math.min(pageNumber, Math.max(0, Math.ceil(rows.length / count) - 1)) : 0;
		const start = pageNumber * count, end = Math.min(rows.length, start + count);
		list.replaceChildren(...rows.slice(start, end).map(makeRow));
		heading.textContent = all ? 'All drafts' : 'Recents';
		back.hidden = !all;
		allButton.hidden = all || rows.length <= count;
		pagination.hidden = !all || !rows.length;
		range.textContent = rows.length ? (start + 1) + '–' + end + ' of ' + rows.length : '';
		previous.disabled = start === 0;
		next.disabled = end >= rows.length;
		if (restoreFocus && oldIndex >= 0) {
			const replacement = list.children[Math.min(oldIndex, list.children.length - 1)];
			(replacement?.querySelector(focusedMenu ? '.recents-more' : '.recents-title') ?? heading).focus();
		} else if (restoreFocus && (focus === next || focus === previous) && focus.disabled) {
			(focus === next && !previous.disabled ? previous : !next.disabled ? next : heading).focus();
		}
	}

	function fit() {
		if (page.hidden || !space.clientHeight) return;
		const style = window.getComputedStyle(space);
		const height = space.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom);
		const size = Math.max(1, Math.floor(height / parseFloat(style.getPropertyValue('--recents-row-height'))));
		if (!Number.isFinite(size) || size === capacity) return;
		pageNumber = Math.floor(pageNumber * capacity / size);
		capacity = size;
		render(true);
	}

	new ResizeObserver(fit).observe(space);
	allButton.addEventListener('click', () => { all = true; render(); heading.focus(); });
	back.addEventListener('click', () => { all = false; render(); (allButton.hidden ? heading : allButton).focus(); });
	previous.addEventListener('click', () => { pageNumber--; render(true); });
	next.addEventListener('click', () => { pageNumber++; render(true); });
	for (const item of menuItems) item.addEventListener('click', () => {
		const row = selected;
		closeMenu(true);
		if (row) action(item.dataset.action, row);
	});
	menu.addEventListener('keydown', event => {
		const index = menuItems.indexOf(document.activeElement);
		switch (event.key) {
			case 'ArrowUp': menuItems[(index + menuItems.length - 1) % menuItems.length].focus(); break;
			case 'ArrowDown': menuItems[(index + 1) % menuItems.length].focus(); break;
			case 'Home': menuItems[0].focus(); break;
			case 'End': menuItems.at(-1).focus(); break;
			case 'Escape': closeMenu(true); event.stopPropagation(); break;
			case 'Tab': closeMenu(true); return;
			default: return;
		}
		event.preventDefault();
	});
	document.addEventListener('pointerdown', event => {
		if (anchor && !anchor.contains(event.target) && !menu.contains(event.target)) closeMenu();
	});

	return {
		open(focus) {
			pending = undefined; all = false; pageNumber = 0; rows = [];
			status.textContent = 'Loading…';
			fit(); render();
			if (focus) heading.focus();
			send('recents-state');
		},
		leave() {
			closeMenu();
			if (summary.open) summary.close();
		},
		update(items, saveWarning, background) {
			const sameRows = background && rows.length === items.length && rows.every((row, index) => {
				const next = items[index];
				return row.projectId === next.projectId && row.promptId === next.promptId && row.updatedAt === next.updatedAt && row.title === next.title;
			});
			rows = items;
			status.textContent = saveWarning ?? (rows.length ? '' : 'No drafts to continue.');
			if (!sameRows) render(true);
		},
		finish({token, summary: data, error}) {
			if (pending === undefined || token !== pending) return;
			pending = undefined;
			if (error) { status.textContent = error; return; }
			if (!data) return;
			$('recents-summary-title').textContent = data.title;
			summaryBody.replaceChildren(...data.lines.flatMap(line =>
				[element('dt', undefined, line.label), element('dd', undefined, line.text)]));
			summary.showModal();
		},
		error(message) { status.textContent = message; }
	};
}
