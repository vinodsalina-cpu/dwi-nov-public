(() => {
	'use strict';

	const vscode = acquireVsCodeApi();
	const root = document.getElementById('project-context');
	const editorSourceId = root.dataset.sourceId;
	const categories = {
		rules: 'Rules', repository: 'Repository', documents: 'Documents',
		connectors: 'Connectors', mcp: 'MCP', 'working-memory': 'Working memory',
	};
	const icons = {
		home: 'M2 7l6-5 6 5v7H9.5v-4h-3v4H2z',
		recents: 'M3 7a5 5 0 1 1 1 5M3 3v4h4m1-2v3l2 1',
		draft: 'm2 12 8-8 2 2-8 8zm6-6 2 2',
		project: 'M2 4h4l1.5 2H14v7H2zM5 8.5h6M5 10.5h4',
	};
	const sourceOnly = category => category === 'connectors' || category === 'mcp';
	let state, pending, draft, preview, error;
	let tab = 'info';
	const expanded = new Set();

	function element(tag, attributes = {}, ...children) {
		const node = document.createElement(tag);
		for (const [key, value] of Object.entries(attributes)) {
			if (value !== undefined && value !== false) node.setAttribute(key, value === true ? '' : String(value));
		}
		node.append(...children);
		return node;
	}

	function icon(name) {
		const ns = 'http://www.w3.org/2000/svg';
		const svg = document.createElementNS(ns, 'svg');
		svg.setAttribute('viewBox', '0 0 16 16');
		svg.setAttribute('width', '16');
		svg.setAttribute('height', '16');
		svg.setAttribute('aria-hidden', 'true');
		const path = document.createElementNS(ns, 'path');
		path.setAttribute('d', icons[name]);
		svg.append(path);
		return svg;
	}

	function button(label, action, options = {}) {
		const node = element('button', {
			type: action ? 'button' : 'submit',
			class: options.class,
			id: options.id,
			disabled: !!pending || options.disabled,
			'aria-label': options.label,
			title: options.title,
		}, label);
		if (action) node.addEventListener('click', action);
		return node;
	}

	function send(type, fields = {}) {
		if (pending) return;
		if (type === 'home' || type === 'recents' || type === 'draft') {
			vscode.postMessage({type});
			return;
		}
		error = undefined;
		pending = {type, draft, projectId: fields.projectId};
		render();
		vscode.postMessage({type, ...fields});
	}

	function local(action, focus) {
		error = undefined;
		action();
		render(focus);
	}

	function textField(formId, name, label, values, options = {}) {
		const id = formId + '-' + name;
		const control = element(options.rows ? 'textarea' : 'input', {
			id, name, rows: options.rows, type: options.rows ? undefined : 'text',
			required: options.required, maxlength: options.maxlength,
			spellcheck: options.path ? 'false' : undefined,
		});
		control.value = values[name] ?? '';
		control.addEventListener('input', () => {
			control.setCustomValidity('');
			values[name] = control.value;
		});
		return element('div', {class: 'pc-field'}, element('label', {for: id}, label), control);
	}

	function choice(id, label, options, value, changed, required = false) {
		const select = element('select', {id, name: id, required}, ...options.map(option =>
			element('option', {value: option.id, disabled: option.disabled}, option.label)));
		select.value = value ?? '';
		if (changed) select.addEventListener('change', () => changed(select.value));
		return element('div', {class: 'pc-field'},
			element('label', {for: id}, label), select);
	}

	function form(id, label, submit, ...children) {
		const node = element('form', {id, 'aria-label': label, method: 'post'});
		node.append(element('fieldset', {disabled: !!pending}, ...children));
		node.addEventListener('submit', event => {
			event.preventDefault();
			if (!pending) submit(node.elements);
		});
		return node;
	}

	function nonblank(control, message) {
		if (control.value.trim()) return true;
		control.setCustomValidity(message);
		control.reportValidity();
		return false;
	}

	function lineList(text) {
		return text.split('\n').map(line => line.trim()).filter(Boolean);
	}

	function pageHeading(title) {
		return element('h1', {id: 'pc-title', tabindex: '-1'}, title);
	}

	function rail() {
		const home = button(icon('home'), () => send('home'), {label: 'Home', title: 'Home', id: 'pc-home'});
		const recents = button(icon('recents'), () => send('recents'), {label: 'Recents', title: 'Recents'});
		const draftButton = button(icon('draft'), () => send('draft'), {label: 'Return to draft', title: 'Return to draft'});
		const current = element('span', {'aria-current': 'page', 'aria-label': 'Project Context'}, icon('project'));
		return element('nav', {class: 'pc-rail', 'aria-label': 'DWI modules'}, home, recents, draftButton, current);
	}

	function projectSelector() {
		const projects = state.projects;
		const selected = state.project?.id ?? '';
		if (!projects.length || (projects.length === 1 && selected && projects[0].id === selected)) return undefined;
		const options = [
			{id: '', label: 'Select a project', disabled: true},
			...projects.map(project => ({id: project.id, label: project.available ? project.name : project.name + ' (unavailable)', disabled: !project.available})),
		];
		return form('pc-switch', 'Switch project', fields => {
			const projectId = fields['pc-project'].value;
			if (projectId && projectId !== selected) send('select', {projectId});
		},
		choice('pc-project', 'Project', options, selected, undefined, true),
		button('Open project', null, {class: 'pc-secondary', id: 'pc-open-project'}));
	}

	function startCreate() {
		const roots = state.roots;
		const folder = roots.length === 1 ? roots[0] : undefined;
		draft = {type: 'create', root: folder?.id ?? '', values: {name: folder?.label ?? ''}};
	}

	function createForm() {
		const data = draft;
		const roots = state.roots;
		const options = [{id: '', label: 'Choose a workspace folder', disabled: true}, ...roots.map(item => ({
			id: item.id, label: item.label + (item.path ? ' · ' + item.path : ''),
		}))];
		const heading = pageHeading('Add project');
		heading.id = 'pc-add-title';
		return element('section', {class: 'pc-card', 'aria-labelledby': heading.id}, heading,
			form('pc-add', 'Add project', fields => {
				if (nonblank(fields.name, 'Enter a project name.')) {
					send('create', {root: data.root, name: data.values.name.trim()});
				}
			},
			choice('pc-root', 'Workspace folder', options, data.root, value => {
				const oldRoot = roots.find(item => item.id === data.root);
				const selected = roots.find(item => item.id === value);
				data.root = value;
				if (!data.values.name.trim() || data.values.name === oldRoot?.label) {
					data.values.name = selected?.label ?? '';
					const name = document.getElementById('pc-add-name');
					name.value = data.values.name;
					name.setCustomValidity('');
				}
			}, true),
			textField('pc-add', 'name', 'Project name', data.values, {required: true, maxlength: 300}),
			element('div', {class: 'pc-actions'},
				button('Cancel', () => local(() => { draft = undefined; }, 'pc-add-project')),
				button('Link project', null, {class: 'pc-primary', disabled: !roots.length || !state.trusted}))));
	}

	function newProjectButton() {
		return button('Add project', () => local(startCreate, state.roots.length === 1 ? 'pc-add-name' : 'pc-root'), {
			id: 'pc-add-project', class: state.project ? 'pc-secondary' : 'pc-primary',
			disabled: !state.trusted || !state.roots.length,
		});
	}

	function empty() {
		const card = element('section', {class: 'pc-card pc-empty'},
			element('h2', {}, 'No project linked'),
			element('p', {class: 'pc-muted'}, !state.trusted ? 'Trust this workspace to link a project.' :
				state.roots.length ? 'Link a workspace folder to manage its brief and sources.' : 'Open a local workspace folder to link a project.'));
		const select = projectSelector();
		if (select) card.append(select);
		if (state.trusted && state.roots.length) card.append(newProjectButton());
		return card;
	}

	function sourceStatus(project, source) {
		if (!source.enabled) return ['Disabled', 'muted'];
		if (sourceOnly(source.category)) return ['Reference only', 'muted'];
		const approval = project.approved.find(item =>
			item.sourceId ? item.sourceId === source.id : source.reference && item.reference === source.reference);
		return approval ? (approval.approved ? ['Approved', 'approved'] : ['Stale', 'warning']) : ['Configured', 'muted'];
	}

	function status(label, tone) {
		return element('span', {class: 'pc-status pc-' + tone}, label);
	}

	function changeProject(project, operation) {
		send('update', {projectId: project.id, revision: draft?.revision ?? project.revision, operation});
	}

	function briefCard(project) {
		const brief = project.setup.brief;
		const saved = !!(brief.content.trim() || brief.unknowns.length || brief.evidenceRefs.length);
		const card = element('section', {class: 'pc-card', 'aria-labelledby': 'pc-brief-title'},
			element('div', {class: 'pc-card-head'}, element('h2', {id: 'pc-brief-title'}, 'Project brief'),
				saved ? button('Edit brief', () => local(() => setBriefDraft(project.id, project.revision, brief), 'pc-brief-content'),
					{id: 'pc-edit-brief', disabled: !project.canEdit}) :
					button('Generate brief', () => send('generateBrief', {projectId: project.id}),
						{id: 'pc-generate-brief', class: 'pc-secondary', disabled: !project.canEdit})),
			element('p', {class: brief.content.trim() ? 'pc-copy' : 'pc-muted'},
				brief.content.trim() ? brief.content : 'No project brief yet.'));
		for (const [label, items] of [['Open questions', brief.unknowns], ['Evidence references', brief.evidenceRefs]]) {
			if (items.length) card.append(element('details', {},
				element('summary', {}, label), element('ul', {class: 'pc-list'}, ...items.map(item => element('li', {}, item)))));
		}
		return card;
	}

	function setBriefDraft(projectId, revision, brief, generated = false) {
		draft = {type: 'brief', projectId, revision, generated, values: {
			content: brief.content,
			unknowns: brief.unknowns.join('\n'),
			evidenceRefs: brief.evidenceRefs.join('\n'),
		}};
	}

	function closeForm(focus) {
		local(() => { draft = undefined; }, focus);
	}

	function savedFormText(project, data) {
		if (data.type === 'brief') {
			const brief = project.setup.brief;
			return [brief.content || 'No saved brief.',
				...(brief.unknowns.length ? ['Open questions', ...brief.unknowns] : []),
				...(brief.evidenceRefs.length ? ['Evidence references', ...brief.evidenceRefs] : [])].join('\n');
		}
		const source = project.setup.sources.find(item => item.id === data.id);
		return source ? [source.title, source.enabled ? 'Enabled' : 'Disabled',
			source.reference, source.content, source.provenance, source.lifetime].filter(Boolean).join('\n') :
			data.type === 'add' ? 'Your new source will be added to the latest project.' : 'This source has been removed.';
	}

	function projectForm(project) {
		const data = draft;
		const isBrief = data.type === 'brief';
		const category = data.category;
		const mode = isBrief ? 'brief' : 'source';
		const formId = 'pc-' + mode;
		const title = isBrief ? (data.generated ? 'Review generated brief' : 'Edit project brief') :
			data.type === 'add' ? 'Add source' : 'Edit source';
		const canSave = project?.id === data.projectId && project.canEdit;
		const stale = canSave && project.revision !== data.revision;
		const heading = pageHeading(title);
		const fields = [];
		if (isBrief) {
			fields.push(textField(formId, 'content', 'Brief', data.values, {rows: 5, maxlength: 20000}),
				textField(formId, 'unknowns', 'Open questions (one per line)', data.values, {rows: 2}),
				textField(formId, 'evidenceRefs', 'Evidence references (one per line)', data.values, {rows: 2}));
		} else {
			fields.push(textField(formId, 'title', 'Source name', data.values, {required: true, maxlength: 300}),
				textField(formId, 'reference',
					category === 'repository' ? 'File path relative to project' : sourceOnly(category) ? 'Reference name or ID' : 'File path or reference (optional)',
					data.values, {path: true, required: category === 'repository' || sourceOnly(category), maxlength: 2000}));
			if (!sourceOnly(category) && category !== 'repository') {
				fields.push(textField(formId, 'content', category === 'documents' ? 'Text (optional for files)' : 'Text', data.values,
					{rows: 4, maxlength: 20000}));
			}
			if (category === 'working-memory') fields.push(
				textField(formId, 'provenance', 'Origin (optional)', data.values, {maxlength: 1000}),
				textField(formId, 'lifetime', 'Lifetime (optional)', data.values, {maxlength: 200}));
			const enabled = element('input', {type: 'checkbox', id: 'pc-enabled', name: 'enabled'});
			enabled.checked = data.values.enabled;
			enabled.addEventListener('change', () => { data.values.enabled = enabled.checked; });
			fields.push(element('div', {class: 'pc-check'}, enabled, element('label', {for: 'pc-enabled'}, 'Enabled')));
		}
		const content = element('section', {class: 'pc-card', 'aria-labelledby': heading.id}, heading);
		if (category) content.append(element('p', {class: 'pc-muted'}, categories[category]));
		if (!canSave) content.append(element('p', {class: 'pc-warning'}, 'This project is unavailable for editing.'));
		if (stale) content.append(element('div', {class: 'pc-notice'},
			element('p', {}, 'The project changed. Review its current values before saving your draft.'),
			button('Show current values', () => local(() => { data.checkLatest = !data.checkLatest; }), {class: 'pc-secondary'}),
			...(data.checkLatest ? [element('pre', {class: 'pc-excerpt', tabindex: '0', role: 'region',
				'aria-label': 'Current saved values'}, savedFormText(project, data)),
				button('Keep editing against current version', () => local(() => {
					data.revision = project.revision;
					data.checkLatest = false;
				}), {class: 'pc-secondary', disabled: data.type === 'edit' && !project.setup.sources.some(source => source.id === data.id)})] : [])));
		content.append(form(formId, title, inputs => {
			if (!canSave || stale) return;
			const values = data.values;
			if (isBrief) {
				changeProject(project, {type: 'brief', brief: {
					content: values.content,
					unknowns: lineList(values.unknowns),
					evidenceRefs: lineList(values.evidenceRefs),
				}});
			} else if (nonblank(inputs.title, 'Enter a source name.') &&
				(!(category === 'repository' || sourceOnly(category)) || nonblank(inputs.reference, 'Enter a reference.'))) {
				const source = {
					title: values.title.trim(), enabled: values.enabled,
					reference: values.reference?.trim() ?? '',
					content: sourceOnly(category) || category === 'repository' ? '' : values.content ?? '',
					provenance: values.provenance?.trim() ?? '',
					lifetime: values.lifetime?.trim() ?? '',
				};
				if (!source.reference && !nonblank(inputs.content, 'Enter text or a file reference.')) return;
				changeProject(project, data.type === 'add' ?
					{type: 'add', source: {category, ...source}} : {type: 'edit', id: data.id, source});
			}
		}, ...fields,
		element('div', {class: 'pc-actions'},
			button('Cancel', () => closeForm(isBrief ? (data.generated ? 'pc-generate-brief' : 'pc-edit-brief') :
				data.type === 'add' ? 'pc-add-' + category : editorSourceId ? 'pc-title' : 'pc-source-' + data.id)),
			button(isBrief ? 'Save brief' : data.type === 'add' ? 'Add source' : 'Save changes', null,
				{class: 'pc-primary', disabled: !canSave || stale}))));
		return content;
	}

	function disclosure(id, label, badge, ...children) {
		const node = element('details', {open: expanded.has(id), class: 'pc-disclosure'},
			element('summary', {id}, element('span', {class: 'pc-disclosure-label'}, label), badge),
			element('div', {class: 'pc-disclosure-body'}, ...children));
		node.addEventListener('toggle', () => {
			if (!node.isConnected) return;
			if (node.open) expanded.add(id);
			else expanded.delete(id);
		});
		return node;
	}

	function sourceBody(project, source) {
		const body = [];
		if (source.reference) body.push(element('p', {class: 'pc-path'}, source.reference));
		if (source.content) body.push(element('pre', {class: 'pc-excerpt', tabindex: '0', role: 'region',
			'aria-label': 'Source text'}, source.content));
		for (const [label, value] of [['Origin', source.provenance], ['Lifetime', source.lifetime]]) {
			if (value) body.push(element('p', {class: 'pc-copy'}, element('strong', {}, label + ' '), value));
		}
		if (project.canEdit && source.enabled && !sourceOnly(source.category) && (source.reference || source.content.trim())) {
			body.push(button('Review excerpt', () => send('reviewSource', {projectId: project.id, sourceId: source.id}), {class: 'pc-secondary'}));
		}
		if (project.canEdit) {
			const list = project.setup.sources.filter(item => item.category === source.category);
			const index = list.findIndex(item => item.id === source.id);
			const makeOp = operation => () => changeProject(project, {id: source.id, ...operation});
			body.push(element('div', {class: 'pc-source-actions'},
				button('Edit', () => local(() => {
					draft = {type: 'edit', projectId: project.id, revision: project.revision,
						category: source.category, id: source.id, values: {...source}};
				}, 'pc-source-title'), {label: 'Edit ' + source.title}),
				button(source.enabled ? 'Disable' : 'Enable', makeOp({type: 'toggle', enabled: !source.enabled}), {
					label: (source.enabled ? 'Disable ' : 'Enable ') + source.title,
				}),
				button('Move up', makeOp({type: 'move', direction: -1}), {disabled: index === 0, label: 'Move ' + source.title + ' up'}),
				button('Move down', makeOp({type: 'move', direction: 1}), {
					disabled: index === list.length - 1, label: 'Move ' + source.title + ' down',
				}),
				button('Remove', makeOp({type: 'remove'}), {class: 'pc-danger', label: 'Remove ' + source.title})));
		}
		return body;
	}

	function categoriesCard(project) {
		const section = element('section', {class: 'pc-card', 'aria-labelledby': 'pc-config-title'},
			element('h2', {id: 'pc-config-title'}, 'Configure sources'));
		for (const [category, label] of Object.entries(categories)) {
			const sources = project.setup.sources.filter(source => source.category === category);
			const contents = sources.map(source =>
				disclosure('pc-source-' + source.id, source.title, status(...sourceStatus(project, source)), ...sourceBody(project, source)));
			if (!sources.length) contents.push(element('p', {class: 'pc-muted'}, 'No sources configured.'));
			if (project.canEdit) contents.push(button('Add source', () => local(() => {
				draft = {type: 'add', projectId: project.id, revision: project.revision,
					category, values: {title: '', reference: '', content: '', enabled: true}};
			}, 'pc-source-title'), {id: 'pc-add-' + category, class: 'pc-secondary', label: 'Add source in ' + label}));
			section.append(disclosure('pc-category-' + category, label, status(String(sources.length), 'muted'), ...contents));
		}
		return section;
	}

	function reviewFilesCard(project) {
		const approved = project.approved;
		const section = element('section', {class: 'pc-card', 'aria-labelledby': 'pc-reviewed-title'},
			element('h2', {id: 'pc-reviewed-title'}, 'Reviewed excerpts'));
		if (approved.length) section.append(element('ul', {class: 'pc-approved-list'}, ...approved.map(item =>
			element('li', {}, element('span', {class: 'pc-path'}, item.reference),
				status(item.approved ? 'Approved' : 'Stale', item.approved ? 'approved' : 'warning')))));
		else section.append(element('p', {class: 'pc-muted'}, 'No approved excerpts yet.'));
		section.append(element('div', {class: 'pc-actions'},
			button('Review files…', () => send('review', {projectId: project.id}), {class: 'pc-primary', disabled: !project.canEdit}),
			...(approved.length ? [button('Preview approved excerpts', () => send('preview', {projectId: project.id}), {class: 'pc-secondary'})] : [])));
		return section;
	}

	function configuredSources(project) {
		const section = element('section', {class: 'pc-card', 'aria-labelledby': 'pc-sources-title'},
			element('h2', {id: 'pc-sources-title'}, 'Configured sources'));
		if (!project.setup.sources.length) {
			section.append(element('p', {class: 'pc-muted'}, 'No sources configured.'));
			return section;
		}
		const rows = project.setup.sources.map(source => element('tr', {},
			element('th', {scope: 'row'}, button(source.title, () => send('openSource', {
				projectId: project.id, sourceId: source.id,
			}), {id: 'pc-open-source-' + source.id, class: 'pc-source-link'})),
			element('td', {}, categories[source.category]),
			element('td', {}, status(...sourceStatus(project, source)))));
		section.append(element('table', {class: 'pc-source-table', 'aria-labelledby': 'pc-sources-title'},
			element('thead', {}, element('tr', {}, ...['Source', 'Category', 'Status'].map(name => element('th', {scope: 'col'}, name)))),
			element('tbody', {}, ...rows)));
		return section;
	}

	function sourceEditor(project) {
		const source = project?.setup.sources.find(item => item.id === editorSourceId);
		if (!source) return element('section', {class: 'pc-card'}, pageHeading('Source unavailable'),
			element('p', {class: 'pc-muted'}, 'This source is no longer available in the project.'));
		return element('article', {class: 'pc-card', 'aria-labelledby': 'pc-title'},
			pageHeading(source.title),
			element('div', {class: 'pc-source-meta'}, element('span', {class: 'pc-muted'}, categories[source.category]),
				status(...sourceStatus(project, source))),
			...sourceBody(project, source));
	}

	function linked(project) {
		const body = element('div', {class: 'pc-stack'});
		const selector = projectSelector();
		if (selector) body.append(selector);
		body.append(element('header', {class: 'pc-project'},
			element('div', {}, element('h2', {}, project.name), element('p', {class: 'pc-path'}, project.path)),
			newProjectButton()));
		const views = element('nav', {class: 'pc-tabs', 'aria-label': 'Project Context views'});
		for (const [id, label] of [['info', 'Info'], ['configure', 'Configure']]) {
			const option = button(label, () => local(() => { tab = id; }, 'pc-tab-' + id), {id: 'pc-tab-' + id});
			if (tab === id) option.setAttribute('aria-current', 'page');
			views.append(option);
		}
		body.append(views);
		if (tab === 'configure') body.append(categoriesCard(project), reviewFilesCard(project));
		else body.append(briefCard(project), configuredSources(project));
		return body;
	}

	function excerptView(review) {
		const title = review ? 'Review excerpts' : 'Approved excerpts';
		const data = review || preview;
		const page = element('section', {class: 'pc-card', 'aria-labelledby': 'pc-title'}, pageHeading(title));
		page.append(element('p', {class: 'pc-muted'},
			review ? 'Approve only the exact excerpts shown below.' : 'Recorded excerpts for this approval.'));
		if (!review && data.versions?.length > 1) {
			const options = data.versions.map(({revision, consentedAt}, index) => {
				const date = new Date(consentedAt);
				const label = Number.isNaN(date.getTime()) ? 'Revision ' + revision :
					date.toLocaleString(undefined, {dateStyle: 'medium', timeStyle: 'short'});
				return {id: revision, label: index === 0 ? 'Latest · ' + label : label};
			});
			page.append(form('pc-preview-version', 'Open another approval version', fields => {
				const revision = Number(fields['pc-approval-version'].value);
				if (revision !== data.revision) send('preview', {projectId: data.projectId, revision});
			}, choice('pc-approval-version', 'Approval version', options, data.revision ?? options[0].id),
			button('Open version', null, {class: 'pc-secondary', id: 'pc-open-version'})));
		}
		for (const [index, source] of data.sources.entries()) {
			const id = 'pc-excerpt-' + index;
			page.append(element('section', {class: 'pc-excerpt-item', 'aria-labelledby': id},
				element('h2', {id, class: 'pc-path'}, source.reference),
				element('pre', {class: 'pc-excerpt', tabindex: '0', role: 'region', 'aria-labelledby': id}, source.excerpt)));
		}
		if (!data.sources.length) page.append(element('p', {class: 'pc-muted'}, 'No excerpts available.'));
		const back = () => review ? send('cancelReview', {projectId: review.projectId, reviewId: review.id}) :
			local(() => { preview = undefined; }, 'pc-title');
		page.append(element('div', {class: 'pc-actions'},
			button(review ? 'Cancel' : 'Back', back),
			...(review ? [button('Approve excerpts', () => send('approve', {
				projectId: review.projectId, reviewId: review.id,
			}), {class: 'pc-primary', disabled: !data.sources.length || !state.project?.canEdit})] : [])));
		return page;
	}

	function render(focus) {
		const previous = document.activeElement;
		const activeId = previous?.id || pending?.focus;
		const selection = previous && 'selectionStart' in previous ? [previous.selectionStart, previous.selectionEnd] : undefined;
		if (pending && !pending.focus) pending.focus = activeId;
		const content = element('div', {class: 'pc-content',
			'aria-busy': pending ? 'true' : undefined});
		const project = state?.project;
		const review = state?.review?.projectId === project?.id ? state?.review : undefined;
		if (error) content.append(element('div', {class: 'pc-error'},
			element('p', {id: 'pc-error', role: 'alert', tabindex: '-1'}, error),
			...(draft?.projectId ? [button('Refresh project', () => send('ready'), {class: 'pc-secondary'})] : [])));
		if (!state) content.append(pageHeading('Project Context'), element('p', {role: 'status', class: 'pc-muted'}, 'Loading projects…'));
		else if (review || preview) content.append(excerptView(review));
		else if (draft) content.append(draft.type === 'create' ? createForm() : projectForm(project));
		else if (editorSourceId) content.append(sourceEditor(project));
		else content.append(pageHeading('Project Context'), project ? linked(project) : empty());
		root.replaceChildren(...(editorSourceId ? [content] : [rail(), content]));
		const target = document.getElementById(focus || activeId);
		if (target && !target.disabled) {
			target.focus();
			if (!focus && selection && selection[0] !== null && typeof target.setSelectionRange === 'function') {
				target.setSelectionRange(...selection);
			}
		}
	}

	window.addEventListener('message', ({data}) => {
		if (data?.type === 'state') {
			if (!pending && state && JSON.stringify(state) === JSON.stringify(data.state)) return;
			const operation = pending;
			const previousProject = state?.project?.id;
			const previousReview = state?.review?.id;
			state = data.state;
			pending = undefined;
			error = undefined;
			if (previousProject !== state.project?.id) {
				tab = 'info';
				expanded.clear();
				preview = undefined;
			}
			const completedDraft = draft && operation?.draft === draft &&
				(operation.type === 'create' && state.project?.id && state.project.id !== previousProject ||
					operation.type === 'update' && state.project?.id === operation.projectId &&
					state.project.revision !== draft.revision);
			const returnTo = completedDraft && draft.type === 'brief' ? 'pc-edit-brief' :
				completedDraft && draft.type === 'add' ? 'pc-category-' + draft.category :
				completedDraft && draft.type === 'edit' && !editorSourceId ? 'pc-source-' + draft.id : 'pc-title';
			if (completedDraft) draft = undefined;
			render(completedDraft ? returnTo :
				state.review?.id !== previousReview || previousProject !== state.project?.id ? 'pc-title' : operation?.focus);
		} else if (data?.type === 'briefDraft' && pending?.type === 'generateBrief' &&
			data.projectId === pending.projectId && data.projectId === state?.project?.id) {
			setBriefDraft(data.projectId, data.revision, data.brief, true);
			pending = undefined;
			error = undefined;
			render('pc-brief-content');
		} else if (data?.type === 'preview' && pending?.type === 'preview' &&
			data.projectId === pending.projectId && data.projectId === state?.project?.id) {
			preview = data;
			pending = undefined;
			error = undefined;
			render('pc-title');
		} else if (data?.type === 'error') {
			pending = undefined;
			error = data.message;
			render('pc-error');
		}
	});

	render();
	vscode.postMessage({type: 'ready'});
})();
