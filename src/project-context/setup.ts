import { contextCategories, contextCharacterLimit } from '../core/context-sources';

export type ContextSourceCategory = keyof typeof contextCategories;
export type ProjectSetupSource = {
  id: string;
  category: ContextSourceCategory;
  title: string;
  enabled: boolean;
  reference: string;
  content: string;
  provenance: string;
  lifetime: string;
};
export type ProjectSetup = {
  brief: { content: string; unknowns: string[]; evidenceRefs: string[] };
  sources: ProjectSetupSource[];
};

const kind = 'dwi-project-setup';
const sourceLimit = 100;
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const sourceId = (value: unknown): value is string =>
  typeof value === 'string' && /^[A-Za-z0-9._~-]{1,200}$/.test(value);
const emptySetup = (): ProjectSetup => ({ brief: { content: '', unknowns: [], evidenceRefs: [] }, sources: [] });

function text(value: unknown, name: string, limit: number): string {
  if (typeof value !== 'string' || value.length > limit || value.includes('\0')) {
    throw new TypeError(`${name} must be text up to ${limit} characters, without null characters.`);
  }
  return value;
}

function textList(value: unknown, name: string, itemLimit: number): string[] {
  if (!Array.isArray(value) || value.length > 100) throw new TypeError(`${name} must contain up to 100 entries.`);
  return Array.from(value, item => {
    const entry = text(item, name, itemLimit).trim();
    if (!entry) throw new TypeError(`${name} entries cannot be empty.`);
    return entry;
  });
}

function readBrief(value: unknown): ProjectSetup['brief'] {
  if (!object(value)) throw new TypeError('Invalid project brief.');
  return {
    content: text(value.content, 'Brief', contextCharacterLimit),
    unknowns: textList(value.unknowns, 'Unknowns', 500),
    evidenceRefs: textList(value.evidenceRefs, 'Evidence references', 200),
  };
}

function readCategory(value: unknown): ContextSourceCategory {
  if (typeof value !== 'string' || !Object.hasOwn(contextCategories, value)) throw new TypeError('Invalid source category.');
  return value as ContextSourceCategory;
}

function readSource(value: unknown, id: string, category: ContextSourceCategory): ProjectSetupSource {
  if (!object(value) || typeof value.enabled !== 'boolean') throw new TypeError('Invalid project source.');
  const title = text(value.title, 'Source title', 300).trim();
  const reference = text(value.reference, 'Source reference', 2_000).trim();
  const content = text(value.content, 'Source content', contextCharacterLimit);
  if (!title) throw new TypeError('Source title cannot be empty.');
  if (category === 'connectors' || category === 'mcp') {
    if (!reference || content) throw new TypeError('Connectors and MCP require a reference and cannot contain inline text.');
  } else if (category === 'repository') {
    const segments = reference.split(/[\\/]/u);
    if (content || /^[A-Za-z]:/u.test(reference) || segments.some(segment => !segment || segment === '.' || segment === '..')) {
      throw new TypeError('Repository sources require a checkout-relative file reference and cannot contain inline text.');
    }
  } else if (!reference && !content.trim()) {
    throw new TypeError('Provide a source reference or text.');
  }
  return {
    id, category, title, reference, content, enabled: value.enabled,
    provenance: text(value.provenance, 'Source provenance', 1_000).trim(),
    lifetime: text(value.lifetime, 'Source lifetime', 200).trim(),
  };
}

function parseSetup(value: Record<string, unknown>): ProjectSetup {
  if (value.schemaVersion !== 1 || !object(value.setup)) throw new TypeError('Unsupported project setup version.');
  const { brief, sources } = value.setup;
  if (!Array.isArray(sources) || sources.length > sourceLimit) throw new TypeError('Invalid project sources.');
  const ids = new Set<string>();
  return {
    brief: readBrief(brief),
    sources: Array.from(sources, source => {
      if (!object(source) || !sourceId(source.id) || ids.has(source.id)) throw new TypeError('Invalid project source ID.');
      ids.add(source.id);
      return readSource(source, source.id, readCategory(source.category));
    }),
  };
}

export function readProjectSetup(value: unknown): ProjectSetup {
  if (object(value) && value.kind === kind) return parseSetup(value);
  return emptySetup();
}

export function reviseProjectSetup(value: unknown, operation: unknown, nextId: () => string): unknown {
  if (!object(operation)) throw new TypeError('Invalid project setup operation.');
  const setup = readProjectSetup(value);
  const sources = setup.sources;
  switch (operation.type) {
    case 'brief':
      setup.brief = readBrief(operation.brief);
      break;
    case 'add': {
      if (!object(operation.source)) throw new TypeError('Invalid project source.');
      if (sources.length >= sourceLimit) throw new TypeError(`A project can have up to ${sourceLimit} sources.`);
      const id = nextId();
      if (!sourceId(id) || sources.some(source => source.id === id)) throw new TypeError('Could not assign a unique project source ID.');
      sources.push(readSource(operation.source, id, readCategory(operation.source.category)));
      break;
    }
    case 'edit':
    case 'remove':
    case 'move':
    case 'toggle': {
      if (!sourceId(operation.id)) throw new TypeError('Invalid project source ID.');
      const index = sources.findIndex(source => source.id === operation.id);
      if (index === -1) throw new TypeError('Project source is unavailable.');
      const current = sources[index];
      if (operation.type === 'edit') {
        sources[index] = readSource(operation.source, current.id, current.category);
      } else if (operation.type === 'remove') {
        sources.splice(index, 1);
      } else if (operation.type === 'toggle') {
        if (typeof operation.enabled !== 'boolean') throw new TypeError('Invalid source enablement.');
        if (current.enabled === operation.enabled) return value;
        current.enabled = operation.enabled;
      } else {
        const direction = operation.direction;
        if (direction !== -1 && direction !== 1) throw new TypeError('Invalid source move direction.');
        let target = index + direction;
        while (sources[target] && sources[target].category !== current.category) target += direction;
        if (!sources[target]) return value;
        [sources[index], sources[target]] = [sources[target], current];
      }
      break;
    }
    default: throw new TypeError('Invalid project setup operation.');
  }

  const prior = object(value) && value.kind === kind ? value : value === undefined ? {} : { legacyDraftSetup: value };
  return { ...prior, kind, schemaVersion: 1, setup };
}
