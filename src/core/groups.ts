/**
 * Arranges items into the groups of the two-panel view: Obsidian's own settings,
 * core plugin settings, community plugins with their settings nested under them,
 * snippets, themes, other files and the profile's sync settings.
 *
 * Files in the root of the config folder that are neither Obsidian settings nor
 * core plugin settings belong to some community plugin that writes outside its
 * own folder. Which plugin cannot be known, so they go to "other".
 */

import type { Change } from "./classify";
import { tryParseJson } from "./canonical";
import { splitKey } from "./model";

export type GroupId = "obsidian" | "core" | "community" | "snippets" | "themes" | "other" | "sync";

export const GROUP_ORDER: GroupId[] = ["obsidian", "core", "community", "snippets", "themes", "other", "sync"];

/** Obsidian's own settings files (not of a core plugin). */
const OBSIDIAN_FILES = new Set(["app", "appearance", "hotkeys", "types", "core-plugins", "core-plugins-migration", "community-plugins"]);

/** Core plugin ids, for when core-plugins.json is not available. */
export const KNOWN_CORE_PLUGINS = [
	"audio-recorder",
	"backlink",
	"bases",
	"bookmarks",
	"canvas",
	"command-palette",
	"daily-notes",
	"editor-status",
	"file-explorer",
	"file-recovery",
	"footnotes",
	"global-search",
	"graph",
	"markdown-importer",
	"note-composer",
	"outgoing-link",
	"outline",
	"page-preview",
	"properties",
	"publish",
	"random-note",
	"slash-command",
	"slides",
	"switcher",
	"sync",
	"tag-pane",
	"templates",
	"webviewer",
	"word-count",
	"workspaces",
	"zk-prefixer",
];

/** Core plugin ids listed in a core-plugins.json text (an object of id → on, or an old-style array). */
export function corePluginIds(...texts: (string | undefined)[]): Set<string> {
	const ids = new Set(KNOWN_CORE_PLUGINS);
	for (const text of texts) {
		const v = text === undefined ? undefined : tryParseJson(text);
		if (Array.isArray(v)) for (const id of v) if (typeof id === "string") ids.add(id);
		if (v && typeof v === "object" && !Array.isArray(v)) for (const id of Object.keys(v)) ids.add(id);
	}
	return ids;
}

export function groupOf(key: string, coreIds: Set<string>): GroupId {
	const { kind, name } = splitKey(key);
	switch (kind) {
		case "plugin":
		case "plugin-data":
			return "community";
		case "snippet":
			return "snippets";
		case "theme":
			return "themes";
		case "settings":
			return "sync";
		default: {
			const base = name.replace(/\.json$/, "");
			if (OBSIDIAN_FILES.has(base)) return "obsidian";
			if (coreIds.has(base)) return "core";
			return "other";
		}
	}
}

export interface TreeRow {
	key: string;
	/** null for an item excluded in this vault: its state is not known. */
	change: Change | null;
	/** Settings of a plugin, nested under the plugin's row. */
	children: TreeRow[];
}

export interface TreeGroup {
	id: GroupId;
	rows: TreeRow[];
}

/**
 * Groups and nests the changes (every compared item, same ones included) and the
 * items excluded in this vault, given as concrete keys.
 */
export function buildTree(changes: Change[], excludedKeys: string[], coreIds: Set<string>): TreeGroup[] {
	const rows = new Map<string, TreeRow>();
	for (const c of changes) rows.set(c.key, { key: c.key, change: c, children: [] });
	for (const key of excludedKeys) if (!rows.has(key)) rows.set(key, { key, change: null, children: [] });

	const groups = new Map<GroupId, TreeRow[]>(GROUP_ORDER.map((g) => [g, []]));
	const sorted = [...rows.values()].sort((a, b) => splitKey(a.key).name.localeCompare(splitKey(b.key).name) || a.key.localeCompare(b.key));
	for (const row of sorted) {
		const { kind, name } = splitKey(row.key);
		const parent = kind === "plugin-data" ? rows.get(`plugin:${name}`) : undefined;
		if (parent) parent.children.push(row);
		else groups.get(groupOf(row.key, coreIds))!.push(row);
	}
	return GROUP_ORDER.map((id) => ({ id, rows: groups.get(id)! })).filter((g) => g.rows.length > 0);
}
