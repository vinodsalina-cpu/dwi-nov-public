import type { WorkspaceConfiguration } from 'vscode';

export type PanelSettings = { enabled: boolean; source: 'none' | 'markov'; fontSize: number };

export const settingsSections = [
	{
		group: 'UI', name: 'Editor', page: 'editor-settings',
		fields: [{
			key: 'editor.fontSize', description: 'Font size',
			accepts: (value: unknown) => typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 72
		}]
	},
	{
		group: 'Advanced', name: 'Logging', page: 'logging-settings',
		fields: [
			{key: 'logging.enabled', description: 'Enable logging', accepts: (value: unknown) => typeof value === 'boolean'},
			{
				key: 'logging.source', description: 'Values to log',
				accepts: (value: unknown, settings: PanelSettings) => settings.enabled && (value === 'none' || value === 'markov')
			}
		]
	}
] as const;

export type SettingsPage = (typeof settingsSections)[number]['page'];
export type SettingKey = (typeof settingsSections)[number]['fields'][number]['key'];

export const settingsGroups = [...new Set(settingsSections.map(section => section.group))];
export const searchableSettings = settingsSections.flatMap(({group, name, page, fields}) =>
	fields.map(({key, description}) => ({label: `${group}.${name}.${key.split('.').pop()}`, description, page, key})));

export function acceptsSetting(key: unknown, value: unknown, settings: PanelSettings): key is SettingKey {
	for (const section of settingsSections) {
		const field = section.fields.find(field => field.key === key);
		if (field) return field.accepts(value, settings);
	}
	return false;
}

export function readPanelSettings(config: WorkspaceConfiguration): PanelSettings {
	const enabled = config.get('logging.enabled', false);
	return {
		enabled,
		source: enabled ? config.get<PanelSettings['source']>('logging.source', 'markov') : 'none',
		fontSize: config.get('editor.fontSize', 0)
	};
}
