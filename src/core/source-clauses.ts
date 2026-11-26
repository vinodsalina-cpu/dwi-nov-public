import { explicitMappingLines } from './mapping-summary';
import type { ContextQuestion, ObligationFrame, ObligationNode, SourceRange, SourceSnapshot } from './edit-contract';

// All slicing uses the worker contract's UTF-16 offsets. Mask technical literals with
// equal-length characters so punctuation inside code cannot split a sentence or a guard.
const sentences = new Intl.Segmenter('en', {granularity: 'sentence'});
const word = /[\p{L}\p{M}\p{N}_]/u;
const guard = /\b(except(?: for)?|excluding|unless|only if|if|when|until|provided that|before|after)\b/gi;
const vague = /\b(appropriate|applicable|ready|suitable|safe|sufficiently|adequately|enough|needed|necessary|required|requested|permitted|approved|stable|acceptable|relevant)\b/i;
const placeholder = /\b(unspecified|unknown|undecided|unidentified|TBD)\b/i;
const explicitName = /^(?:["'`]|[A-Z])|[a-z][A-Z]|[\w.-][/\\.][\w-]/u;

function missingDecision(question: ContextQuestion, phrase: string, before: string, after: string, rest: string) {
	const text = phrase.trim();
	if (!text || /^(?:\s*[:=]|\s+(?:named|called|located (?:at|in)))\s*\S/i.test(after)) return false;
	const component = question.question === 'Which file or component is the target?' &&
		/^(?:(?:the|an?)\s+)?(?:appropriate|affected|relevant|intended|selected)\s+(?:(backend|frontend)\s+)?(?:service|component|file|module)$/i.exec(text);
	// A following definition can answer a candidate in an earlier sentence.
	const noun = text.match(/[a-z]+$/i)?.[0];
	if (noun) {
		const layer = component && component[1] ? `(?:${component[1]}\\s+)?` : '';
		const qualifier = component ? '(?:(?:appropriate|affected|relevant|intended|selected)\\s+)?' : '(?:affected\\s+)?';
		const subject = '(?:^|[.!?\\n])\\s*(?:the\\s+)?' + qualifier + layer + noun;
		const definition = new RegExp(subject +
			'\\s*(?::|=|is\\s+(?:named\\s+|called\\s+|(?=[`"\']|[\\w/-]+[/.][\\w/-]+)))\\s*(?!unknown\\b|unspecified\\b|TBD\\b)\\S', 'i');
		if (definition.test(rest) || definition.test(before)) return false;
		if (component) {
			const assigned = new RegExp(subject + '\\s+is\\s+(\\S+)', 'gi');
			for (const section of [before, rest]) {
				for (const [, value] of section.matchAll(assigned)) {
					if (explicitName.test(value) && !placeholder.test(value)) return false;
				}
			}
		}
	}
	if (placeholder.test(text)) return true;
	switch (question.question) {
		case 'Which file or component is the target?': {
			// A tier such as “backend” narrows the kind of service but does not name it.
			// A directly attached identifier, path or quoted name does supply the target.
			const label = after.match(/^\s*[,–—]?\s*([^\s,;]+)/u)?.[1];
			if (component && label && explicitName.test(label)) return false;
			return (component || /^(?:(?:the\s+)?(?:affected|relevant|intended|selected)\s+\S+|(?:this|that)(?:\s+\S+)?|it|them)$/i.test(text))
				&& !/^\s*(?:\(|\b(?:in|at|under)\s+\S*[/\\.][\w-])/i.test(after)
				&& !(/^(it|them|this|that)$/i.test(text) && /(?:\x60[^\x60]+\x60|\b[\w./-]+\.\w+)\s*[.!?]\s+\w+\s*$/i.test(before));
		}
		case 'What does this reference refer to?':
			return /\b(this|that|previous|earlier|former|mentioned|discussed)\b/i.test(text);
		case 'Which condition must be satisfied?':
			// “when ready” leaves the criterion open; “when all replicas are
			// ready” supplies a subject and a predicate.
			return vague.test(text) && !/\b\w+\s+(?:is|are|has|have)\s*$/i.test(before) &&
				!/\b\w+\s+(?:is|are|has|have)\s+\w/i.test(text) && !/^\s+(?:by|means|for \d)\b/i.test(after);
		case 'What scope should this request cover?':
			return vague.test(text);
		case 'What decision should be used here?':
			return /\b(which(?:ever)?|best|better|preferred|ideal|optimal|most suitable|most appropriate|or)\b/i.test(text);
		default:
			return false;
	}
}

function guardParts(body: string) {
	const terminal = body.replace(/[.!?]+$/u,'').trimEnd().length || body.length;
	const markers = [...body.matchAll(guard)];
	return markers.flatMap((marker,i) => {
		const from = marker.index;
		const limit = markers[i+1]?.index ?? terminal;
		const tail = body.slice(from,limit).replace(/[,\s]+$/,'');
		// A leading guard ends at the comma before its action. An embedded
		// comma in a trailing guard can enumerate several required checks.
		if (!from && tail.split(',').length > 2) return [];
		const fragment = tail.split(from === 0 ? /[,;]/ : /;/,1)[0].trimEnd();
		if (fragment.length <= marker[0].length) return [];
		const role = /^(?:except|excluding|unless)/i.test(marker[0]) ? 'exception' : 'condition';
		return [{role, from, to:from+fragment.length}] as const;
	});
}

export function checkSourceClauses(source: SourceSnapshot, proposed: ObligationFrame) {
	const {text, boundaries} = source;
	const offsets = new Map(boundaries.map(b => [b.id, b.offset]));
	const ids = new Map(boundaries.map(b => [b.offset, b.id]));
	const start = (r: SourceRange) => offsets.get(r.start)!;
	const end = (r: SourceRange) => offsets.get(r.end)!;
	const quote = (r: SourceRange) => text.slice(start(r), end(r));
	// Round outwards if a punctuation or whitespace boundary lies within a grapheme.
	const range = (a: number, b: number): SourceRange => ({
		start: ids.get(a) ?? boundaries.filter(point => point.offset < a).at(-1)!.id,
		end: ids.get(b) ?? boundaries.find(point => point.offset > b)!.id,
	});
	const midWord = (i: number) => word.test(text.slice(0,i).match(/.$/u)?.[0] ?? '') && word.test(text.slice(i).match(/^./u)?.[0] ?? '');
	const whole = (r: SourceRange) => !midWord(start(r)) && !midWord(end(r));
	const literals = source.protectedLiterals.map(l => l.range);
	let masked = text;
	for (const r of literals) masked = masked.slice(0,start(r)) + quote(r).replace(/[^\r\n]/g,'x') + masked.slice(end(r));
	const {metadata} = explicitMappingLines(text);
	for (const {start:a, end:b} of metadata) masked = masked.slice(0,a) + ' '.repeat(b-a) + masked.slice(b);
	// Treat an ordinary soft-wrapped line as part of the same sentence.
	const sentenceInput = masked.replace(/(\S[^.!?:;\s])([^\S\r\n]*\r?\n[ \t]*)(?=\p{Ll})/gu,
		(_, prefix:string, space:string) => prefix + ' '.repeat(space.length));
	const clauses = Array.from(sentences.segment(sentenceInput), ({index,segment}) => {
		const a = index + segment.length - segment.trimStart().length, b = index + segment.trimEnd().length;
		const body = masked.slice(a,b);
		return {a,b,body,modifiers:guardParts(body)};
	}).filter(c => c.a < c.b);
	const owner = (r: SourceRange) => clauses.find(c => c.a <= start(r) && end(r) <= c.b);
	const accepted: ContextQuestion[] = [];
	const unresolved = proposed.unresolved.filter(q => {
		if (!q.evidence.length || !q.evidence.every(r => whole(r) && owner(r) &&
			!literals.some(l => start(l) < end(r) && start(r) < end(l)) &&
			missingDecision(q,quote(r),text.slice(0,start(r)),text.slice(end(r),owner(r)!.b),text.slice(end(r))))) return false;
		// Distinct occurrences can need different answers. Suppress only the
		// same decision anchored to overlapping evidence at this occurrence.
		if (accepted.some(prior => prior.question === q.question && prior.evidence.length === q.evidence.length &&
			q.evidence.every(r => prior.evidence.some(p => start(r) < end(p) && start(p) < end(r))))) return false;
		accepted.push(q);
		return true;
	});

	const spans = proposed.nodes.flatMap(n => n.evidence);
	const located = new Map(proposed.nodes.map(n => [n.id,owner(n.evidence[0])]));
	const ungroundedGuard = clauses.some(c => c.modifiers.some(part => !proposed.nodes.some(n =>
		n.role === part.role && n.evidence.some(r => start(r) <= c.a+part.from && end(r) >= c.a+part.to))));
	const disconnected = proposed.relations.some(e => located.get(e.from) !== located.get(e.to));
	const missed = Array.from(masked.matchAll(/[\p{L}\p{M}\p{N}_]+/gu)).some(m =>
		!/^(?:a|an|the|please)$/i.test(m[0]) && !spans.some(r => start(r) <= m.index && m.index + m[0].length <= end(r)));
	// Even fully covered words can be attached to the wrong action. Keep the written
	// clauses when the graph proposes order or several actions in one sentence.
	const actionNodes = proposed.nodes.filter(n => n.role === 'action');
	const competing = clauses.some(c => actionNodes.filter(n => n.evidence.some(r => owner(r) === c)).length > 1);
	if (!disconnected && !missed && !competing && !ungroundedGuard && !actionNodes.some(n => n.evidence.length > 1) && spans.every(r => whole(r) && owner(r)) &&
		!proposed.relations.some(edge => edge.kind === 'before')) {
		return {frame:{...proposed, unresolved}, clauseBacked:false};
	}

	const nodes: ObligationNode[] = [], relations: ObligationFrame['relations'][number][] = [];
	function add(role: ObligationNode['role'], evidence: SourceRange, action?: string) {
		const id = 's' + nodes.length;
		nodes.push(role === 'action' ? {id,role,evidence:[evidence],modality:'unspecified'} : {id,role,evidence:[evidence]});
		if (action && role !== 'action' && role !== 'literal') relations.push({id:'r'+relations.length,kind:role,from:action,to:id});
		return id;
	}
	for (const c of clauses) {
		// Keep the entire statement for a prefixed condition or a compound instruction.
		// Only lift trailing guards out of a single objective when their order is clear.
		const modifiers = c.modifiers;
		const terminal = c.body.replace(/[.!?]+$/u,'').trimEnd().length || c.body.length;
		const first = modifiers[0]?.from ?? terminal;
		const head = c.body.slice(0,first).replace(/[,\s]+$/,'');
		// Split only when the resulting pieces account for the entire suffix.
		// Keep nested and coordinated guards together with their governing action.
		const split = clauses.length === 1 && head.length && modifiers.length && !c.body.slice(first).includes(';') &&
			!/["“”]|\b(?:and|or|then)\b/i.test(c.body.slice(first)) && !/["“”]/.test(head) &&
			!/\b(?:ask|check|verify|determine|test|decide|see)\s*$/i.test(head) &&
			modifiers.every((part,i) => !c.body.slice(part.from,part.to).includes(',') && /^[,\s]*$/.test(c.body.slice(part.to,modifiers[i+1]?.from ?? terminal)) &&
				(!i || c.body.slice(modifiers[i-1].to,part.from).includes(',')));
		const actionEnd = split ? head.length : c.body.length;
		const action = add('action',range(c.a,c.a+actionEnd));
		for (const part of modifiers) add(part.role,range(c.a+part.from,c.a+part.to),action);

		const prefix = c.body.slice(0,first);
		const scope = /\b(?:within|across|throughout|only in|only on|in|on)\s+[^,;.!?]+/i.exec(prefix);
		if (scope && (!/^on\b/i.test(scope[0]) || prefix.slice(0,scope.index).trim().includes(' '))) {
			const value = scope[0].trimEnd();
			add('scope',range(c.a+scope.index,c.a+scope.index+value.length),action);
		}
		// Keep intact model detail spans when local to this statement. The recovered
		// action already includes its objects; never link it to another sentence's target.
		for (const n of proposed.nodes) {
			if (!['target','scope','quantity','comparator','literal'].includes(n.role)) continue;
			for (const r of n.evidence) if (whole(r) && owner(r) === c && start(r) >= c.a && end(r) <= c.a+actionEnd)
				add(n.role,r,action);
		}
	}
	return {frame:{...proposed,nodes,relations,unresolved}, clauseBacked:true};
}
