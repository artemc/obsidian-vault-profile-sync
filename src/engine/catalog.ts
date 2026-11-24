/**
 * Obsidian community catalogs and release downloads.
 * Plugins are downloaded from the GitHub release of the pinned version, the same
 * files Obsidian itself installs: manifest.json, main.js and optional styles.css.
 */

import { tryParseJson, utf8Decode, utf8Encode } from "../core/canonical";
import type { Http } from "../io";

const RELEASES = "https://raw.githubusercontent.com/obsidianmd/obsidian-releases/HEAD";
const CACHE_MS = 60 * 60 * 1000;

interface CatalogEntry {
	id?: string;
	name?: string;
	repo: string;
}

export type FileSet = Map<string, Uint8Array>;

export class Catalog {
	private plugins: { at: number; byId: Map<string, string> } | null = null;
	private themes: { at: number; byName: Map<string, string> } | null = null;

	constructor(private readonly http: Http) {}

	private async load(file: string): Promise<CatalogEntry[]> {
		const res = await this.http({ url: `${RELEASES}/${file}` });
		if (res.status !== 200) throw new Error(`Could not download the Obsidian catalog ${file} (${res.status}).`);
		const parsed = tryParseJson(res.text);
		if (!Array.isArray(parsed)) throw new Error(`The Obsidian catalog ${file} is not a list.`);
		return parsed as unknown as CatalogEntry[];
	}

	async pluginRepo(id: string): Promise<string | null> {
		if (!this.plugins || Date.now() - this.plugins.at > CACHE_MS) {
			const list = await this.load("community-plugins.json");
			this.plugins = { at: Date.now(), byId: new Map(list.filter((e) => e.id).map((e) => [e.id as string, e.repo])) };
		}
		return this.plugins.byId.get(id) ?? null;
	}

	async themeRepo(name: string): Promise<string | null> {
		if (!this.themes || Date.now() - this.themes.at > CACHE_MS) {
			const list = await this.load("community-css-themes.json");
			this.themes = { at: Date.now(), byName: new Map(list.filter((e) => e.name).map((e) => [e.name as string, e.repo])) };
		}
		return this.themes.byName.get(name) ?? null;
	}
}

const NO_SOURCEMAP = "\n/* nosourcemap */";

/**
 * What Obsidian's own installer does to main.js: drop source map comments and append
 * a "nosourcemap" marker. Applying it keeps our installs byte-identical to Obsidian's.
 */
export function asInstalledByObsidian(mainJs: string): string {
	if (mainJs.endsWith(NO_SOURCEMAP)) return mainJs;
	return mainJs.replace(/\/\/# sourceMappingURL=[^\r\n]*/g, "") + NO_SOURCEMAP;
}

function tagCandidates(version: string): string[] {
	const bare = version.replace(/^v/i, "");
	return [...new Set([version, bare, `v${bare}`])];
}

async function fetchBytes(http: Http, url: string): Promise<Uint8Array | null> {
	const res = await http({ url });
	if (res.status !== 200) return null;
	return new Uint8Array(res.arrayBuffer);
}

function manifestVersion(bytes: Uint8Array | undefined): string | null {
	if (!bytes) return null;
	const m = tryParseJson(utf8Decode(bytes)) as { version?: unknown } | undefined;
	return m && typeof m.version === "string" ? m.version : null;
}

/** Download the release files of plugin `repo` at `version`. */
export async function downloadPlugin(http: Http, repo: string, version: string): Promise<FileSet> {
	for (const tag of tagCandidates(version)) {
		const base = `https://github.com/${repo}/releases/download/${encodeURIComponent(tag)}`;
		const main = await fetchBytes(http, `${base}/main.js`);
		if (!main) continue;
		const manifest = await fetchBytes(http, `${base}/manifest.json`);
		if (!manifest) continue;
		const files: FileSet = new Map([
			["main.js", utf8Encode(asInstalledByObsidian(utf8Decode(main)))],
			["manifest.json", manifest],
		]);
		const styles = await fetchBytes(http, `${base}/styles.css`);
		if (styles) files.set("styles.css", styles);
		const got = manifestVersion(manifest);
		if (got !== null && got.replace(/^v/i, "") !== version.replace(/^v/i, "")) {
			throw new Error(`Release ${tag} of ${repo} contains version ${got}, expected ${version}.`);
		}
		return files;
	}
	throw new Error(`No release ${version} with main.js and manifest.json found in ${repo}.`);
}

/**
 * Download theme `repo`. Themes are often not released per version, so the release
 * of `version` is tried first and the default branch second; the version actually
 * received is returned so the caller can report a mismatch.
 */
export async function downloadTheme(http: Http, repo: string, version: string): Promise<{ files: FileSet; version: string | null }> {
	const bases = [
		...tagCandidates(version).map((t) => `https://github.com/${repo}/releases/download/${encodeURIComponent(t)}`),
		`https://raw.githubusercontent.com/${repo}/HEAD`,
	];
	for (const base of bases) {
		const css = await fetchBytes(http, `${base}/theme.css`);
		if (!css) continue;
		const manifest = await fetchBytes(http, `${base}/manifest.json`);
		if (!manifest) continue;
		return {
			files: new Map([
				["theme.css", css],
				["manifest.json", manifest],
			]),
			version: manifestVersion(manifest),
		};
	}
	throw new Error(`Could not download theme files from ${repo}.`);
}
