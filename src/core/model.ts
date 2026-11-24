/**
 * Item model shared by the local scanner, the remote reader and the sync engine.
 *
 * An item is the unit of comparison. File items map to one file in the profile
 * repository; entry items (plugins, themes, sync settings) live inside
 * profile.json, so that edits to different plugins never conflict on that file.
 */

import { canonicalJson, gitBlobSha, tryParseJson, type Json } from "./canonical";

export type ItemKind = "plugin" | "plugin-data" | "config" | "snippet" | "theme" | "settings";

export const PROFILE_FILE = "profile.json";
export const PROFILE_SCHEMA = 1;
export const SETTINGS_KEY = "settings:sync";

export type Source = "catalog" | "vendor";

export interface PluginEntry {
	version: string;
	enabled: boolean;
	source: Source;
}

export interface ThemeEntry {
	version: string;
	source: Source;
}

/** Sync settings shared by every vault that uses the profile. */
export interface SharedSettings {
	/** Item keys or names that are never synced, see exclude.ts. */
	exclude: string[];
	/** Extra JSON key names whose string values are treated as secrets. */
	secretKeys: string[];
	/**
	 * Key names that look like secrets but are not (for example a list of session
	 * names called `pluginTokens`). Values shaped like credentials are still removed.
	 */
	plainKeys: string[];
}

export interface ProfileFile {
	schema: number;
	plugins: Record<string, PluginEntry>;
	themes: Record<string, ThemeEntry>;
	settings: SharedSettings;
}

/**
 * One side of the comparison for one item.
 * `text` is the canonical content as stored in the repository (file items) or the
 * canonical entry text (entry items). Remote file items may not have text until
 * it is downloaded.
 */
export interface SnapItem {
	key: string;
	kind: ItemKind;
	name: string;
	hash: string;
	text?: string;
	plugin?: PluginEntry;
	theme?: ThemeEntry;
	settings?: SharedSettings;
}

export type Snapshot = Map<string, SnapItem>;

export function itemKey(kind: ItemKind, name: string): string {
	return `${kind}:${name}`;
}

export function splitKey(key: string): { kind: ItemKind; name: string } {
	const i = key.indexOf(":");
	return { kind: key.slice(0, i) as ItemKind, name: key.slice(i + 1) };
}

export function isEntryKind(kind: ItemKind): boolean {
	return kind === "plugin" || kind === "theme" || kind === "settings";
}

/** Path of a file item relative to the profile folder, or null for entry items. */
export function itemRepoPath(kind: ItemKind, name: string): string | null {
	switch (kind) {
		case "config":
			return `config/${name}`;
		case "plugin-data":
			return `plugins/${name}/data.json`;
		case "snippet":
			return `snippets/${name}.css`;
		default:
			return null;
	}
}

/** Reverse of itemRepoPath for file items. */
export function repoPathToItem(path: string): { kind: ItemKind; name: string } | null {
	let m = /^config\/([^/]+\.json)$/.exec(path);
	if (m) return { kind: "config", name: m[1] };
	m = /^plugins\/([^/]+)\/data\.json$/.exec(path);
	if (m) return { kind: "plugin-data", name: m[1] };
	m = /^snippets\/([^/]+)\.css$/.exec(path);
	if (m) return { kind: "snippet", name: m[1] };
	return null;
}

export function vendorPluginDir(id: string): string {
	return `vendor/plugins/${id}`;
}

export function vendorThemeDir(name: string): string {
	return `vendor/themes/${name}`;
}

export const PLUGIN_FILES = ["manifest.json", "main.js", "styles.css"];
export const THEME_FILES = ["manifest.json", "theme.css"];

export function emptySettings(): SharedSettings {
	return { exclude: [], secretKeys: [], plainKeys: [] };
}

export function emptyProfile(): ProfileFile {
	return { schema: PROFILE_SCHEMA, plugins: {}, themes: {}, settings: emptySettings() };
}

function stringList(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

export function normalizeSettings(value: unknown): SharedSettings {
	const v = (value ?? {}) as Record<string, unknown>;
	return { exclude: stringList(v.exclude), secretKeys: stringList(v.secretKeys), plainKeys: stringList(v.plainKeys) };
}

export function parseProfile(text: string): ProfileFile {
	const raw = tryParseJson(text);
	if (raw === undefined || raw === null || typeof raw !== "object" || Array.isArray(raw)) {
		throw new Error("profile.json is not a JSON object");
	}
	const r = raw as Record<string, Json>;
	if (typeof r.schema === "number" && r.schema > PROFILE_SCHEMA) {
		throw new Error(`profile.json schema ${r.schema} is newer than this plugin supports (${PROFILE_SCHEMA}). Update the plugin.`);
	}
	const profile = emptyProfile();
	const plugins = (r.plugins ?? {}) as Record<string, Record<string, unknown>>;
	for (const [id, e] of Object.entries(plugins)) {
		if (!e || typeof e.version !== "string") continue;
		profile.plugins[id] = {
			version: e.version,
			enabled: e.enabled !== false,
			source: e.source === "vendor" ? "vendor" : "catalog",
		};
	}
	const themes = (r.themes ?? {}) as Record<string, Record<string, unknown>>;
	for (const [name, e] of Object.entries(themes)) {
		if (!e || typeof e.version !== "string") continue;
		profile.themes[name] = { version: e.version, source: e.source === "vendor" ? "vendor" : "catalog" };
	}
	profile.settings = normalizeSettings(r.settings);
	return profile;
}

export function serializeProfile(profile: ProfileFile): string {
	return canonicalJson(profile);
}

/** Canonical text of a plugin entry as compared. The source is not compared. */
export function pluginEntryText(e: { version: string; enabled: boolean }): string {
	return canonicalJson({ enabled: e.enabled, version: e.version });
}

export function themeEntryText(e: { version: string }): string {
	return canonicalJson({ version: e.version });
}

/** plainKeys is written only when set, so profiles made before it existed keep their hash. */
export function settingsText(s: SharedSettings): string {
	return canonicalJson(s.plainKeys.length > 0 ? { exclude: s.exclude, plainKeys: s.plainKeys, secretKeys: s.secretKeys } : { exclude: s.exclude, secretKeys: s.secretKeys });
}

export async function pluginItem(id: string, entry: PluginEntry): Promise<SnapItem> {
	const text = pluginEntryText(entry);
	return { key: itemKey("plugin", id), kind: "plugin", name: id, hash: await gitBlobSha(text), text, plugin: entry };
}

export async function themeItem(name: string, entry: ThemeEntry): Promise<SnapItem> {
	const text = themeEntryText(entry);
	return { key: itemKey("theme", name), kind: "theme", name, hash: await gitBlobSha(text), text, theme: entry };
}

export async function settingsItem(settings: SharedSettings): Promise<SnapItem> {
	const text = settingsText(settings);
	return { key: SETTINGS_KEY, kind: "settings", name: "sync", hash: await gitBlobSha(text), text, settings };
}

export async function fileItem(kind: ItemKind, name: string, text: string): Promise<SnapItem> {
	return { key: itemKey(kind, name), kind, name, hash: await gitBlobSha(text), text };
}
