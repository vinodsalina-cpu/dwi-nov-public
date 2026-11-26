import type { PromptMapping, ReviewFields } from './prompt-mapping';

const unique = (items: readonly string[]) => [...new Set(items.map(text => text.trim()).filter(Boolean))];

function includesPhrase(text: string, phrase: string) {
	const literal = phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	return new RegExp('(?<![\\p{L}\\p{N}_])' + literal + '(?![\\p{L}\\p{N}_])', 'u').test(text);
}

function question(text: string) {
	const body = text.trim().replace(/[.?]+$/, '');
	if (text.endsWith('?')) return text;
	if (/^(what|which|who|where|when|why|how|should|must|can|does|do|is|are)\b/i.test(body)) return body + '?';
	const missing = /^(?:missing|unspecified|unclear)\s*:\s*(.+)$/i.exec(body) ??
		/^(.+?)\s+(?:is|was)\s+(?:missing|unspecified|unclear|unknown)$/i.exec(body);
	if (!missing) return text;
	const subject = missing[1];
	if (/^(what|which|where|how|when)\b/i.test(subject)) return subject[0].toUpperCase() + subject.slice(1) + '?';
	return 'What is ' + (/^(?:the|a|an|its)\s/i.test(subject) ? '' : 'the ') + subject + '?';
}

function actionText(value: string, mode: string) {
	if (mode === 'prohibited' && !/^(?:do not|don['’]t|never|must not|cannot|can['’]t)\b/i.test(value)) return 'Do not ' + value;
	if (mode === 'permitted' && !/^(?:may|can|optionally)\b/i.test(value)) return 'May ' + value;
	return value;
}

// Preserve source punctuation between split spans, e.g. “React” and “based calculator”.
function targetList(values: string[], wording: string) {
	const groups: string[] = [];
	for (const value of values) {
		const last = groups.at(-1);
		const separator = last && ['-', '–', '/', '.'].find(sep => wording.includes(last + sep + value));
		if (separator) groups[groups.length - 1] = last + separator + value;
		else groups.push(value);
	}
	return groups.join(', ');
}

/** Project only validated fields. Wording supplies punctuation, never missing decisions. */
export function summarizeMapping(frame: PromptMapping, parsed = frame, wording = '') {
	if (parsed.graph?.clauseBacked) {
		const actions = frame.actions.map((v, i) => actionText(v, frame.modalities[i]));
		const [goal, ...rest] = actions;
		const details = unique([...frame.targets, ...frame.scope, ...frame.constraints, ...frame.conditions,
			...frame.exceptions, ...frame.quantities, ...frame.comparators, ...frame.literals]);
		return {objective: goal ? [goal] : [], requirements: unique([...rest,
			...details.filter(value => !actions.some(line => includesPhrase(line,value)))]),
			unresolved: unique(frame.unresolved.map(question))};
	}
	const originalActions = parsed.graph?.nodes.filter(n => n.role === 'action' && n.quotes.some(q => q.trim())) ?? [];
	const aligned = originalActions.length === frame.actions.length && frame.actions.every((v,i) => v === parsed.actions[i]);
	const relations = aligned ? parsed.graph?.relations ?? [] : [];
	const actionIndex = new Map(originalActions.map((node,i) => [node.id,i]));
	const orderedEdges = relations.filter(edge => edge.kind === 'before' && actionIndex.has(edge.from) && actionIndex.has(edge.to) && edge.from !== edge.to)
		.map(edge => [actionIndex.get(edge.from)!, actionIndex.get(edge.to)!]);
	const names = frame.actions.map((value, i) => actionText(value, frame.modalities[i]));
	const unusedTargets = new Set(unique(frame.targets));
	const targetGroups = names.map((_,i) => {
		const links = relations.filter(edge => edge.from === originalActions[i]?.id && edge.kind === 'target');
		const targets = names.length === 1 ? unique(frame.targets) : unique(links.flatMap(edge =>
			parsed.graph?.nodes.find(n => n.role === 'target' && n.id === edge.to)?.quotes ?? []).filter(q => frame.targets.includes(q)));
		for (const target of targets) unusedTargets.delete(target);
		return targets;
	});
	const shared = names.length > 1 ? targetGroups[0].filter(t => targetGroups.every(group => group.includes(t))) : [];
	const actions = names.map((name,i) => {
		const extra = targetGroups[i].filter(t => !shared.includes(t) && !includesPhrase(name,t));
		return extra.length ? name + ' ' + targetList(extra, wording) : name;
	});
	const requirements: string[] = [];
	const sequence = frame.root_intent === 'SEQUENCE';
	// A partial order does not imply that all the other actions must run sequentially.
	let objective = sequence && !orderedEdges.length ? [actions.join(' → ')] : unique(actions);
	if (shared.length) {
		const verbs = sequence && !orderedEdges.length ? actions.join(' → ') : new Intl.ListFormat('en', {type:'conjunction'}).format(unique(actions));
		const extra = shared.filter(t => !actions.every(a => includesPhrase(a,t)));
		objective = [extra.length ? verbs + ' — ' + targetList(extra, wording) : verbs];
	}
	for (const [from,to] of orderedEdges) requirements.push(actions[from] + ' before ' + actions[to]);
	const targets = [...unusedTargets].filter(t => !actions.some(a => includesPhrase(a,t)));
	if (targets.length) requirements.push('Targets: ' + targetList(targets, wording));

	const covered = (value: string) => objective.some(line => includesPhrase(line, value));
	// A condition on one of several actions must not silently become a condition on the entire request.
	for (const [role, values] of [['scope', frame.scope], ['condition', frame.conditions], ['exception', frame.exceptions],
		['comparator', frame.comparators], ['quantity', frame.quantities]] as const) {
		for (const value of unique(values)) {
			let clause = value;
			if (role === 'condition' && !/^(if|when|whenever|unless|after|before|until|only|provided)\b/i.test(value)) clause = 'Condition: ' + value;
			if (role === 'exception' && !/^(except|excluding|other than|unless)\b/i.test(value)) clause = 'Except: ' + value;
			const linked = actions.length > 1 ? actions.filter((_,i) => relations.some(edge =>
				edge.from === originalActions[i]?.id && edge.kind === role &&
				parsed.graph?.nodes.some(n => n.id === edge.to && n.quotes.includes(value)))) : [];
			if ((role === 'quantity' || role === 'comparator') && !linked.length && frame.constraints.some(c => c !== value && includesPhrase(c,value))) continue;
			if (linked.length && linked.length < actions.length) {
				for (const action of linked) if (!includesPhrase(action,value)) requirements.push(action + ' — ' + clause);
			} else if (!covered(value) || role === 'exception' || role === 'condition') requirements.push(clause);
		}
	}
	const restrictions = [...frame.conditions, ...frame.exceptions, ...frame.scope, ...frame.comparators, ...frame.quantities];
	for (const value of unique([...frame.constraints,...frame.literals])) {
		if (!covered(value) && !restrictions.includes(value) && !requirements.some(req => includesPhrase(req,value))) requirements.push(value);
	}
	return {objective: objective.filter(Boolean), requirements: unique(requirements), unresolved: unique(frame.unresolved.map(question))};
}

// Status lists and file references in pasted briefs can be read directly when the author labels them.
const headings = new Map<string, keyof import('./prompt-mapping').ReviewFields>([
	['decision','decisions'], ['decisions','decisions'], ['completed','completed'], ['done','completed'],
	['queued','queued'], ['deferred','deferred'], ['blocked','blocked'], ['next move','nextMove'],
	['relevant files','files'], ['attached files','files'], ['important context','context'],
	['objective','objective'], ['requirements','requirements'],
]);

export function explicitMappingLines(wording: string) {
	let section: keyof ReviewFields | undefined;
	let fence = '';
	const explicit: ReviewFields = {};
	const metadata: {start:number; end:number}[] = [];
	for (const {0:raw,index} of wording.matchAll(/[^\r\n]+/g)) {
		const line = raw.trim();
		const skip = (length = raw.length) => metadata.push({start:index, end:index+length});
		const marker = /^(\x60{3,}|~{3,})/.exec(line)?.[1];
		if (marker && !fence) { fence = marker; section = undefined; skip(); continue; }
		if (fence) { skip(); if (line.startsWith(fence)) fence = ''; continue; }
		const item = line.replace(/^[-*+]\s+|^\d+[.)]\s+/, '');
		const plain = item.replace(/^#{1,6}\s+/, '').replaceAll('**','');
		const heading = /^(.*?)(?::\s*(.*))?$/.exec(plain);
		const field = heading && headings.get(heading[1].trim().toLowerCase());
		if (/^work state:?$/i.test(plain)) { skip(); section = undefined; continue; }
		if (field) {
			const content = heading?.[2];
			skip(content && (field === 'objective' || field === 'requirements') ? raw.lastIndexOf(content) : raw.length);
			section = field;
			if (heading?.[2]) (explicit[field] ??= []).push(heading[2]);
		} else if (section && item !== line) {
			skip(section === 'objective' || section === 'requirements' ? raw.lastIndexOf(item) : raw.length);
			(explicit[section] ??= []).push(item);
		}
		else if (line) section = undefined;
	}
	return {explicit, metadata};
}

export function mappingSections(frame: PromptMapping, parsed: PromptMapping, wording: string) {
	const sections: import('./prompt-mapping').ReviewFields = {...summarizeMapping(frame, parsed, wording)};
	const {explicit} = explicitMappingLines(wording);
	for (const [key, values] of Object.entries(explicit))
		sections[key as keyof typeof sections] = unique([...(sections[key as keyof typeof sections] ?? []), ...values]);
	return {...sections, ...frame.reviewFields};
}
