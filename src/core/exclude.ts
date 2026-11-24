/**
 * Exclusion rules.
 *
 * A pattern with a colon matches item keys (`plugin:obsidian-git`, `config:graph.json`,
 * `plugin-data:*`); a pattern without a colon matches the item name of any kind
 * (`obsidian-git` excludes both the plugin and its settings). `*` matches any run of
 * characters. Excluding a plugin also excludes its settings.
 */

import { itemKey, splitKey } from "./model";

/** Never synced, whatever the user configures. */
export const BUILTIN_EXCLUDE = [
	"config:workspace.json",
	"config:workspace-mobile.json",
	"config:workspaces.json",
	"config:bookmarks.json",
	"config:community-plugins.json",
];

function toRegExp(pattern: string): RegExp {
	const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
	return new RegExp(`^${escaped}$`);
}

export class ExcludeRules {
	private readonly keyRules: RegExp[] = [];
	private readonly nameRules: RegExp[] = [];

	constructor(patterns: string[]) {
		for (const raw of [...BUILTIN_EXCLUDE, ...patterns]) {
			const p = raw.trim();
			if (!p || p.startsWith("#")) continue;
			(p.includes(":") ? this.keyRules : this.nameRules).push(toRegExp(p));
		}
	}

	private matches(key: string, name: string): boolean {
		return this.keyRules.some((r) => r.test(key)) || this.nameRules.some((r) => r.test(name));
	}

	isExcluded(key: string): boolean {
		const { kind, name } = splitKey(key);
		if (kind === "settings") return false;
		if (this.matches(key, name)) return true;
		if (kind === "plugin-data") return this.matches(itemKey("plugin", name), name);
		return false;
	}
}

/** Split a multi-line text field into patterns. */
export function parsePatternList(text: string): string[] {
	return text
		.split(/\r?\n/)
		.map((l) => l.trim())
		.filter((l) => l.length > 0 && !l.startsWith("#"));
}
