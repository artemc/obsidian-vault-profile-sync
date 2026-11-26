import type { Base, Change } from "../../src/core/classify";
import { emptySettings, type SharedSettings } from "../../src/core/model";
import { Catalog } from "../../src/engine/catalog";
import { SyncEngine, type SyncStatus } from "../../src/engine/sync";
import { GitHubClient } from "../../src/remote/github";
import { GitHubStore, type ProfileStore } from "../../src/remote/store";
import type { Http } from "../../src/io";
import type { FakeGitHub } from "./fakegithub";
import { MemFs } from "./memfs";

export const CFG = ".obsidian";

/** One vault with the plugin installed: its files, its base and its shared settings. */
export class Vault {
	fs = new MemFs();
	base: Base = {};
	shared: SharedSettings = emptySettings();
	localExclude: string[] = [];
	loaded = new Set<string>();
	disabled: string[] = [];
	/** What the engine talks to; a test may wrap it, e.g. in an HTTP cache. */
	http: Http;

	constructor(
		readonly name: string,
		readonly gh: FakeGitHub,
		readonly folder = "",
		/** The profile store; GitHub (the fake) when not given. The catalog always uses `gh`. */
		readonly makeStore?: () => ProfileStore,
	) {
		this.fs.put(`${CFG}/app.json`, "{}");
		this.fs.put(`${CFG}/community-plugins.json`, "[]");
		this.fs.put(`${CFG}/workspace.json`, '{"main": "vault specific"}');
		this.fs.put(`${CFG}/plugins/vault-profile-sync/manifest.json`, '{"id":"vault-profile-sync","version":"0.1.0"}');
		this.http = gh.http;
	}

	engine(): SyncEngine {
		return new SyncEngine(
			{
				fs: this.fs,
				http: this.http,
				host: {
					isPluginLoaded: (id) => this.loaded.has(id),
					disablePlugin: async (id) => {
						this.disabled.push(id);
						this.loaded.delete(id);
					},
				},
				store: this.makeStore?.() ?? new GitHubStore(new GitHubClient(this.http, this.gh.owner, this.gh.repo, "tok"), "main", this.folder),
				catalog: new Catalog(this.http),
			},
			{
				configDir: CFG,
				selfId: "vault-profile-sync",
				vaultName: this.name,
				localExclude: this.localExclude,
				shared: this.shared,
			},
		);
	}

	installPlugin(id: string, version: string, data?: unknown, enabled = true): void {
		this.fs.put(`${CFG}/plugins/${id}/manifest.json`, JSON.stringify({ id, name: id, version }));
		this.fs.put(`${CFG}/plugins/${id}/main.js`, `// ${id} ${version}\n\n/* nosourcemap */`);
		if (data !== undefined) this.fs.put(`${CFG}/plugins/${id}/data.json`, JSON.stringify(data));
		const list = this.fs.json(`${CFG}/community-plugins.json`) as string[];
		if (enabled && !list.includes(id)) this.fs.put(`${CFG}/community-plugins.json`, JSON.stringify([...list, id]));
		this.loaded.add(id);
	}

	uninstallPlugin(id: string): void {
		void this.fs.rmdir(`${CFG}/plugins/${id}`, true);
		const list = (this.fs.json(`${CFG}/community-plugins.json`) as string[]).filter((x) => x !== id);
		this.fs.put(`${CFG}/community-plugins.json`, JSON.stringify(list));
		this.loaded.delete(id);
	}

	async status(): Promise<SyncStatus> {
		return this.engine().compare(this.base);
	}

	async push(pick?: (c: Change) => boolean): Promise<SyncStatus> {
		const s = await this.status();
		const changes = [...s.result.outgoing, ...s.result.conflicts].filter(pick ?? (() => true));
		const r = await this.engine().push(s, changes, s.result.settledBase);
		this.base = r.base;
		return s;
	}

	/** Pull incoming changes; conflicts are taken from the profile when takeConflicts is set. */
	async pull(takeConflicts = false) {
		const s = await this.status();
		const changes = [...s.result.incoming, ...(takeConflicts ? s.result.conflicts : [])];
		const r = await this.engine().pull(s, changes, s.result.settledBase);
		this.base = r.base;
		if (r.shared) this.shared = r.shared;
		return r;
	}

	async counts() {
		const r = (await this.status()).result;
		return { incoming: r.incoming.map((c) => c.key), outgoing: r.outgoing.map((c) => c.key), conflicts: r.conflicts.map((c) => c.key) };
	}

	plugins(): string[] {
		return [...this.fs.dirs].filter((d) => /^\.obsidian\/plugins\/[^/]+$/.test(d)).map((d) => d.split("/")[2]).filter((id) => id !== "vault-profile-sync").sort();
	}
}

