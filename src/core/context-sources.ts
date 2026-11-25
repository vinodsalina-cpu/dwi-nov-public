// Source categories from the earlier DWI Project Context app.
export const contextCategories = {
	rules: 'Rules',
	repository: 'Repository',
	documents: 'Documents',
	connectors: 'Connectors',
	mcp: 'MCP',
	'working-memory': 'Working Memory',
} as const;

type ContextCategory = keyof typeof contextCategories;
export type ContextSource = Readonly<{ id: string; label: string }> & (
	| Readonly<{ category: Exclude<ContextCategory, 'connectors' | 'mcp'>; content: string }>
	| Readonly<{ category: 'connectors' | 'mcp' }>
);

export const contextCharacterLimit = 20_000;

export function includeContextSources(prompt: string, sources: readonly ContextSource[]): string {
	const included = sources.flatMap(source => 'content' in source && source.content.trim()
		? [`[${contextCategories[source.category]}] ${source.label}\n${source.content}`]
		: []);
	return included.length ? `${prompt}\n\nRelevant Context\n\n${included.join('\n\n')}` : prompt;
}
