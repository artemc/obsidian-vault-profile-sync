/**
 * Reads the vault's config folder into a snapshot of items.
 * JSON settings are canonicalized and secrets are redacted before hashing, so the
 * snapshot holds exactly what a push would upload.
 */

import { canonicalJson, tryParseJson, type Json } from "../core/canonical";
import type { ExcludeRules } from "../core/exclude";
import {
	fileItem,
	itemKey,
	pluginItem,
	SETTINGS_KEY,
	settingsItem,
	themeItem,
	type SharedSettings,
	type Snapshot,
	type SnapItem,
} from "../core/model";
import { redactSecrets, type SecretMatcher } from "../core/secrets";
import { baseName, joinPath, readTextIfExists, type Fs } from "../io";

export interface LocalPlugin {
	id: string;
	folder: string;
	version: string;
	enabled: boolean;
}

export interface LocalTheme {
	name: string;
	folder: string;
	version: string;
}

export interface LocalState {
	snapshot: Snapshot;
	plugins: Map<string, LocalPlugin>;
	themes: Map<string, LocalTheme>;
	/** Raw content of community-plugins.json (enabled community plugin ids, in order). */
	enabledPlugins: string[];
}

export interface ScanOptions {
	configDir: string;
	selfId: string;
	exclude: ExcludeRules;
	secrets: SecretMatcher;
	shared: SharedSettings;
}

/** Canonical text of a JSON settings file as it is stored in the profile. */
export function settingsFileText(raw: string, secrets: SecretMatcher): string {
	const parsed = tryParseJson(raw);
	if (parsed === undefined) return raw;
	return canonicalJson(redactSecrets(parsed, secrets));
}

async function readJson(fs: Fs, path: string): Promise<Json | undefined> {
	const text = await readTextIfExists(fs, path);
	return text === null ? undefined : tryParseJson(text);
}

export async function readEnabledPlugins(fs: Fs, configDir: string): Promise<string[]> {
	const v = await readJson(fs, joinPath(configDir, "community-plugins.json"));
	return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

export async function scanLocal(fs: Fs, opts: ScanOptions): Promise<LocalState> {
	const { configDir, exclude, secrets } = opts;
	const snapshot: Snapshot = new Map();
	const add = (item: SnapItem) => {
		if (!exclude.isExcluded(item.key)) snapshot.set(item.key, item);
	};

	const root = await fs.list(configDir);
	for (const path of root.files) {
		const name = baseName(path);
		if (!name.endsWith(".json") || exclude.isExcluded(itemKey("config", name))) continue;
		add(await fileItem("config", name, settingsFileText(await fs.read(path), secrets)));
	}

	const enabledPlugins = await readEnabledPlugins(fs, configDir);
	const enabled = new Set(enabledPlugins);
	const plugins = new Map<string, LocalPlugin>();
	const pluginsDir = joinPath(configDir, "plugins");
	if (await fs.exists(pluginsDir)) {
		for (const folder of (await fs.list(pluginsDir)).folders) {
			const manifest = (await readJson(fs, joinPath(folder, "manifest.json"))) as { id?: unknown; version?: unknown } | undefined;
			if (!manifest || typeof manifest.version !== "string") continue;
			const id = typeof manifest.id === "string" ? manifest.id : baseName(folder);
			if (id === opts.selfId) continue;
			const plugin: LocalPlugin = { id, folder, version: manifest.version, enabled: enabled.has(id) };
			if (exclude.isExcluded(itemKey("plugin", id))) continue;
			plugins.set(id, plugin);
			add(await pluginItem(id, { version: plugin.version, enabled: plugin.enabled, source: "catalog" }));
			const data = await readTextIfExists(fs, joinPath(folder, "data.json"));
			if (data !== null) add(await fileItem("plugin-data", id, settingsFileText(data, secrets)));
		}
	}

	const snippetsDir = joinPath(configDir, "snippets");
	if (await fs.exists(snippetsDir)) {
		for (const path of (await fs.list(snippetsDir)).files) {
			const name = baseName(path);
			if (!name.endsWith(".css")) continue;
			add(await fileItem("snippet", name.slice(0, -4), await fs.read(path)));
		}
	}

	const themes = new Map<string, LocalTheme>();
	const themesDir = joinPath(configDir, "themes");
	if (await fs.exists(themesDir)) {
		for (const folder of (await fs.list(themesDir)).folders) {
			const manifest = (await readJson(fs, joinPath(folder, "manifest.json"))) as { name?: unknown; version?: unknown } | undefined;
			const name = manifest && typeof manifest.name === "string" ? manifest.name : baseName(folder);
			const version = manifest && typeof manifest.version === "string" ? manifest.version : "0.0.0";
			if (exclude.isExcluded(itemKey("theme", name))) continue;
			themes.set(name, { name, folder, version });
			add(await themeItem(name, { version, source: "catalog" }));
		}
	}

	snapshot.set(SETTINGS_KEY, await settingsItem(opts.shared));
	return { snapshot, plugins, themes, enabledPlugins };
}
