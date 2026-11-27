/**
 * The sync engine: compare the vault with the profile, apply incoming changes
 * (pull) and publish outgoing ones (push). It never persists anything about itself;
 * it returns the new base and shared settings and the caller stores them.
 */

import { canonicalJson, tryParseJson, utf8Encode } from "../core/canonical";
import { classify, outgoingAction, type Base, type Change, type Classification } from "../core/classify";
import { ExcludeRules } from "../core/exclude";
import {
	itemRepoPath,
	PLUGIN_FILES,
	PROFILE_FILE,
	SETTINGS_KEY,
	serializeProfile,
	emptySettings,
	THEME_FILES,
	vendorPluginDir,
	vendorThemeDir,
	type ItemKind,
	type ProfileFile,
	type SharedSettings,
} from "../core/model";
import { commonKeys, restoreSecrets, SecretMatcher } from "../core/secrets";
import { joinPath, listRecursive, readTextIfExists, writeBytes, type Fs, type Host, type Http } from "../io";
import type { TreeWrite } from "../remote/github";
import type { ProfileStore } from "../remote/store";
import { BackupStore } from "./backup";
import { downloadPlugin, downloadTheme, type Catalog, type FileSet } from "./catalog";
import { readEnabledPlugins, scanLocal, type LocalState } from "./local";
import { RemoteReader, type RemoteState } from "./remote";

export interface SyncConfig {
	configDir: string;
	selfId: string;
	vaultName: string;
	localExclude: string[];
	shared: SharedSettings;
}

export interface SyncDeps {
	fs: Fs;
	http: Http;
	host: Host;
	store: ProfileStore;
	catalog: Catalog;
}

export interface SyncStatus {
	local: LocalState;
	remote: RemoteState;
	result: Classification;
}

export interface Failure {
	key: string;
	error: string;
}

/** Called before each change is prepared (downloads happen here): done so far, total, item key. */
export type PullProgress = (done: number, total: number, key: string) => void;

export interface PullResult {
	base: Base;
	shared: SharedSettings | null;
	applied: string[];
	failed: Failure[];
	warnings: string[];
	backupDir: string | null;
}

export interface PushResult {
	base: Base;
	commit: string;
	pushed: string[];
}

type Op = { type: "write"; path: string; bytes: Uint8Array } | { type: "delete"; path: string } | { type: "rmdir"; path: string };

interface PreparedPull {
	change: Change;
	ops: Op[];
	disable: string[];
	enabled?: { id: string; value: boolean | null };
	shared?: SharedSettings;
	createdDir?: string;
	warning?: string;
}

const JSON_KINDS: ItemKind[] = ["config", "plugin-data"];

export class SyncEngine {
	readonly reader: RemoteReader;

	constructor(
		private readonly deps: SyncDeps,
		private readonly cfg: SyncConfig,
	) {
		this.reader = new RemoteReader(deps.store);
	}

	/** This plugin never syncs itself, on either side. */
	private rules(extra: string[] = []): ExcludeRules {
		return new ExcludeRules([...this.cfg.shared.exclude, ...extra, ...this.cfg.localExclude, `plugin:${this.cfg.selfId}`]);
	}

	/**
	 * The profile is read first: its shared exclusions and secret keys apply even
	 * before this vault has pulled them. Otherwise a vault that has not pulled a new
	 * secret key yet would push that secret in clear text. For the same reason a key
	 * counts as not secret only when both this vault and the profile say so.
	 */
	/**
	 * Secret rules for scanning this vault against a profile with `remote` settings,
	 * when the vault's own shared settings are `local`.
	 */
	private matcher(local: SharedSettings, remote: SharedSettings): SecretMatcher {
		return new SecretMatcher([...local.secretKeys, ...remote.secretKeys], commonKeys(local.plainKeys, remote.plainKeys));
	}

	async compare(base: Base): Promise<SyncStatus> {
		const remote = await this.reader.read(this.rules());
		const remoteSettings = remote.profile.settings;
		const rules = this.rules(remoteSettings.exclude);
		for (const key of [...remote.snapshot.keys()]) if (rules.isExcluded(key)) remote.snapshot.delete(key);
		const local = await scanLocal(this.deps.fs, {
			configDir: this.cfg.configDir,
			selfId: this.cfg.selfId,
			exclude: rules,
			secrets: this.matcher(this.cfg.shared, remoteSettings),
			shared: this.cfg.shared,
		});
		return { local, remote, result: classify(local.snapshot, remote.snapshot, base) };
	}

	/** Text of one side of a change for the diff view; undefined if absent. */
	async sideText(status: SyncStatus, change: Change, side: "local" | "remote"): Promise<string | undefined> {
		const item = side === "local" ? change.local : change.remote;
		if (!item) return undefined;
		if (item.text !== undefined) return item.text;
		const rel = itemRepoPath(item.kind, item.name);
		return rel ? this.reader.text(status.remote, rel) : undefined;
	}

	// ---------------------------------------------------------------- pull

	private pluginFolder(status: SyncStatus, id: string): string {
		return status.local.plugins.get(id)?.folder ?? joinPath(this.cfg.configDir, "plugins", id);
	}

	private localPath(status: SyncStatus, kind: ItemKind, name: string): string {
		switch (kind) {
			case "config":
				return joinPath(this.cfg.configDir, name);
			case "plugin-data":
				return joinPath(this.pluginFolder(status, name), "data.json");
			case "snippet":
				return joinPath(this.cfg.configDir, "snippets", `${name}.css`);
			default:
				throw new Error(`No local file for ${kind}`);
		}
	}

	private async vendorFiles(status: SyncStatus, dir: string): Promise<FileSet | null> {
		const files: FileSet = new Map();
		for (const [path, sha] of status.remote.files) {
			if (path.startsWith(`${dir}/`)) files.set(path.slice(dir.length + 1), await this.reader.blob(sha));
		}
		return files.size > 0 ? files : null;
	}

	private loaded(id: string): string[] {
		return this.deps.host.isPluginLoaded(id) ? [id] : [];
	}

	private async preparePull(status: SyncStatus, change: Change, secrets: SecretMatcher): Promise<PreparedPull> {
		const { fs } = this.deps;
		const remote = change.remote;
		const { kind, name } = (remote ?? change.local)!;
		const prepared: PreparedPull = { change, ops: [], disable: [] };

		if (kind === "config" || kind === "plugin-data" || kind === "snippet") {
			const path = this.localPath(status, kind, name);
			if (kind === "plugin-data") prepared.disable = this.loaded(name);
			if (!remote) {
				if (await fs.exists(path)) prepared.ops.push({ type: "delete", path });
				return prepared;
			}
			// A merged change carries its text; otherwise it is read from the profile.
			let text = remote.text ?? (await this.reader.text(status.remote, itemRepoPath(kind, name)!));
			if (JSON_KINDS.includes(kind)) {
				const incoming = tryParseJson(text);
				if (incoming !== undefined) {
					const current = await readTextIfExists(fs, path);
					text = canonicalJson(restoreSecrets(incoming, current === null ? undefined : tryParseJson(current), secrets));
				}
			}
			if (kind === "plugin-data" && !(await fs.exists(this.pluginFolder(status, name)))) {
				prepared.createdDir = this.pluginFolder(status, name);
			}
			prepared.ops.push({ type: "write", path, bytes: utf8Encode(text) });
			return prepared;
		}

		if (kind === "plugin") {
			const local = status.local.plugins.get(name);
			const folder = this.pluginFolder(status, name);
			prepared.disable = this.loaded(name);
			if (!remote?.plugin) {
				if (local) prepared.ops.push({ type: "rmdir", path: local.folder });
				prepared.enabled = { id: name, value: null };
				return prepared;
			}
			const entry = remote.plugin;
			if (!local || local.version !== entry.version) {
				let files: FileSet | null = null;
				if (entry.source === "vendor") files = await this.vendorFiles(status, vendorPluginDir(name));
				if (!files) {
					const repo = await this.deps.catalog.pluginRepo(name);
					if (repo) files = await downloadPlugin(this.deps.http, repo, entry.version);
					else files = await this.vendorFiles(status, vendorPluginDir(name));
				}
				if (!files) throw new Error(`Plugin ${name} is not in the Obsidian catalog and the profile has no copy of it.`);
				for (const f of PLUGIN_FILES) {
					const bytes = files.get(f);
					if (bytes) prepared.ops.push({ type: "write", path: joinPath(folder, f), bytes });
					else if (await fs.exists(joinPath(folder, f))) prepared.ops.push({ type: "delete", path: joinPath(folder, f) });
				}
				if (!local && !(await fs.exists(folder))) prepared.createdDir = folder;
			}
			prepared.enabled = { id: name, value: entry.enabled };
			return prepared;
		}

		if (kind === "theme") {
			const local = status.local.themes.get(name);
			const folder = local?.folder ?? joinPath(this.cfg.configDir, "themes", name);
			if (!remote?.theme) {
				if (local) prepared.ops.push({ type: "rmdir", path: local.folder });
				return prepared;
			}
			const entry = remote.theme;
			if (!local || local.version !== entry.version) {
				let files: FileSet | null = null;
				if (entry.source === "vendor") files = await this.vendorFiles(status, vendorThemeDir(name));
				if (!files) {
					const repo = await this.deps.catalog.themeRepo(name);
					if (!repo) throw new Error(`Theme ${name} is not in the Obsidian catalog and the profile has no copy of it.`);
					const got = await downloadTheme(this.deps.http, repo, entry.version);
					files = got.files;
					if (got.version && got.version !== entry.version) {
						prepared.warning = `Theme ${name}: version ${entry.version} is not published, installed ${got.version}.`;
					}
				}
				for (const f of THEME_FILES) {
					const bytes = files.get(f);
					if (bytes) prepared.ops.push({ type: "write", path: joinPath(folder, f), bytes });
				}
				if (!local && !(await fs.exists(folder))) prepared.createdDir = folder;
			}
			return prepared;
		}

		// settings
		prepared.shared = remote?.settings ?? emptySettings();
		return prepared;
	}

	/**
	 * Apply the profile's side of the given changes to the vault.
	 * Every change is prepared (downloads included) before anything is written;
	 * a change that cannot be prepared is reported and left out.
	 */
	async pull(status: SyncStatus, changes: Change[], base: Base, onProgress?: PullProgress): Promise<PullResult> {
		const { fs, host } = this.deps;
		const result: PullResult = { base: { ...base }, shared: null, applied: [], failed: [], warnings: [], backupDir: null };
		const ready: PreparedPull[] = [];
		// Restored secrets must scan back to the profile's text under the rules the
		// next comparison uses; pulling settings:sync makes the profile's settings ours.
		const remoteSettings = status.remote.profile.settings;
		const takesSettings = changes.some((c) => c.key === SETTINGS_KEY && c.remote);
		const secrets = this.matcher(takesSettings ? remoteSettings : this.cfg.shared, remoteSettings);
		for (const [i, change] of changes.entries()) {
			onProgress?.(i, changes.length, change.key);
			try {
				ready.push(await this.preparePull(status, change, secrets));
			} catch (e) {
				result.failed.push({ key: change.key, error: e instanceof Error ? e.message : String(e) });
			}
		}
		if (ready.length === 0) return result;

		const communityPlugins = joinPath(this.cfg.configDir, "community-plugins.json");
		const touched: string[] = [];
		for (const p of ready) {
			for (const op of p.ops) {
				if (op.type === "rmdir") touched.push(...(await listRecursive(fs, op.path)));
				else touched.push(op.path);
			}
		}
		const enabledChanges = ready.filter((p) => p.enabled);
		if (enabledChanges.length > 0) touched.push(communityPlugins);
		const createdDirs = ready.map((p) => p.createdDir).filter((d): d is string => !!d);

		const backups = new BackupStore(fs, joinPath(this.cfg.configDir, "plugins", this.cfg.selfId, "backups"));
		result.backupDir = await backups.create(`Pull of ${ready.length} change(s)`, base, touched, createdDirs);

		for (const id of new Set(ready.flatMap((p) => p.disable))) {
			try {
				await host.disablePlugin(id);
			} catch {
				// The plugin may already be unloaded; the reload afterwards settles it.
			}
		}

		for (const p of ready) {
			for (const op of p.ops) {
				if (op.type === "write") await writeBytes(fs, op.path, op.bytes);
				else if (op.type === "delete") {
					if (await fs.exists(op.path)) await fs.remove(op.path);
				} else if (await fs.exists(op.path)) await fs.rmdir(op.path, true);
			}
			if (p.shared) result.shared = p.shared;
			if (p.warning) result.warnings.push(p.warning);
			if (p.change.remote) result.base[p.change.key] = p.change.remote.hash;
			else delete result.base[p.change.key];
			result.applied.push(p.change.key);
		}

		if (enabledChanges.length > 0) {
			const list = await readEnabledPlugins(fs, this.cfg.configDir);
			for (const p of enabledChanges) {
				const { id, value } = p.enabled!;
				const i = list.indexOf(id);
				if (value && i < 0) list.push(id);
				if (!value && i >= 0) list.splice(i, 1);
			}
			await fs.write(communityPlugins, JSON.stringify(list, null, 2));
		}
		return result;
	}

	// ---------------------------------------------------------------- push

	private vendorPaths(remote: RemoteState, dir: string): string[] {
		return [...remote.files.keys()].filter((p) => p.startsWith(`${dir}/`));
	}

	/**
	 * Publish this vault's side of the given changes as one write on top of the
	 * version the comparison was made against. Throws RemoteMovedError if it moved.
	 */
	async push(status: SyncStatus, changes: Change[], base: Base): Promise<PushResult> {
		const remote = status.remote;

		const writes = new Map<string, string | null>();
		const write = (rel: string, content: string | null) => writes.set(rel, content);
		const profile: ProfileFile = structuredClone(remote.profile);
		let profileChanged = !remote.profileExists;

		for (const change of changes) {
			const local = change.local;
			const { kind, name } = (local ?? change.remote)!;
			if (kind === "config" || kind === "plugin-data" || kind === "snippet") {
				const rel = itemRepoPath(kind, name)!;
				if (local?.text !== undefined) write(rel, local.text);
				else if (remote.files.has(rel)) write(rel, null);
				continue;
			}
			profileChanged = true;
			if (kind === "settings") {
				profile.settings = structuredClone(this.cfg.shared);
				continue;
			}
			const isPlugin = kind === "plugin";
			const dir = isPlugin ? vendorPluginDir(name) : vendorThemeDir(name);
			const stale = new Set(this.vendorPaths(remote, dir));
			if (local) {
				const repo = isPlugin ? await this.deps.catalog.pluginRepo(name) : await this.deps.catalog.themeRepo(name);
				const source = repo ? "catalog" : "vendor";
				if (source === "vendor") {
					const folder = isPlugin ? status.local.plugins.get(name)!.folder : status.local.themes.get(name)!.folder;
					for (const f of isPlugin ? PLUGIN_FILES : THEME_FILES) {
						const text = await readTextIfExists(this.deps.fs, joinPath(folder, f));
						if (text === null) continue;
						write(`${dir}/${f}`, text);
						stale.delete(`${dir}/${f}`);
					}
				}
				if (isPlugin) profile.plugins[name] = { version: local.plugin!.version, enabled: local.plugin!.enabled, source };
				else profile.themes[name] = { version: local.theme!.version, source };
			} else if (isPlugin) delete profile.plugins[name];
			else delete profile.themes[name];
			for (const p of stale) write(p, null);
		}
		if (profileChanged) write(PROFILE_FILE, serializeProfile(profile));

		const lines = changes.map((c) => `- ${c.key} (${outgoingAction(c)})`);
		const message = `Update ${changes.length} item(s) from vault "${this.cfg.vaultName}"\n\n${lines.join("\n")}\n`;
		const treeWrites: TreeWrite[] = [...writes].map(([path, content]) => ({ path, content }));
		const commit = await this.deps.store.write(remote.head, treeWrites, message);

		const newBase = { ...base };
		for (const c of changes) {
			if (c.local) newBase[c.key] = c.local.hash;
			else delete newBase[c.key];
		}
		return { base: newBase, commit, pushed: changes.map((c) => c.key) };
	}
}
