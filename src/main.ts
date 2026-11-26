/**
 * Vault Profile Sync: one settings profile in a GitHub repository or a folder, shared by many vaults.
 * This file wires the engine to Obsidian: stored settings and base, token,
 * commands, ribbon, status bar and the background check.
 */

import { Notice, Plugin } from "obsidian";
import type { Base, Change } from "./core/classify";
import { emptySettings, normalizeSettings, type SharedSettings } from "./core/model";
import { BackupStore } from "./engine/backup";
import { Catalog } from "./engine/catalog";
import { SyncEngine, type PullProgress, type PullResult, type PushResult, type SyncStatus } from "./engine/sync";
import { joinPath } from "./io";
import { MACHINE_TOKEN_KEY, TokenStore } from "./core/token";
import { adapterFs, appHost, appStorage, nodeDisk, obsidianHttp, reloadApp, systemCipher } from "./obsidian-host";
import { hasLocation, sameStore, type StoreRef } from "./core/stores";
import { FolderStore } from "./remote/folder";
import { GitHubClient, parseRepo } from "./remote/github";
import { GitHubStore, type ProfileStore } from "./remote/store";
import { t } from "./ui/i18n";
import { ProfileSettingTab } from "./ui/SettingsTab";
import { SyncModal } from "./ui/SyncModal";

export interface PluginData extends StoreRef {
	repo: string;
	branch: string;
	folder: string;
	checkOnStartup: boolean;
	checkIntervalMin: number;
	localExclude: string[];
	shared: SharedSettings;
	/** What this vault and the profile at `location` last agreed on. Never synced. */
	base: { location: string; items: Base };
}

const DEFAULTS: PluginData = {
	kind: "github",
	path: "",
	repo: "",
	branch: "main",
	folder: "",
	checkOnStartup: true,
	checkIntervalMin: 30,
	localExclude: [],
	shared: emptySettings(),
	base: { location: "", items: {} },
};

const TOKEN_SECRET = "vault-profile-sync-github-token";
/** Shared by all vaults on this machine (window.localStorage is per app, not per vault). */
const LAST_REMOTE_KEY = "vault-profile-sync:last-remote";
/** Stores used on this machine, most recent first. */
export const STORES_KEY = "vault-profile-sync:stores";

export default class VaultProfileSync extends Plugin {
	data: PluginData = structuredClone(DEFAULTS);
	lastStatus: SyncStatus | null = null;
	private busy = false;
	private statusEl: HTMLElement | null = null;
	private catalog = new Catalog(obsidianHttp);
	private notifiedHead: string | null = null;
	private intervalId: number | null = null;

	async onload(): Promise<void> {
		await this.loadPluginData();
		try {
			this.tokens().migrate();
		} catch (e) {
			console.warn("[vault-profile-sync] could not move the token to the shared copy", e);
		}
		this.addSettingTab(new ProfileSettingTab(this.app, this));
		this.addRibbonIcon("folder-sync", t("openProfile"), () => this.openModal());
		this.statusEl = this.addStatusBarItem();
		this.statusEl.addClass("mod-clickable", "vps-status");
		this.statusEl.onClickEvent(() => this.openModal());
		this.setStatusText();
		// The shared token was set or removed in another vault's window.
		this.registerDomEvent(window, "storage", (e: StorageEvent) => {
			if (e.key === MACHINE_TOKEN_KEY) this.setStatusText();
		});

		this.addCommand({ id: "open", name: t("openProfile"), callback: () => this.openModal() });
		this.addCommand({ id: "undo-last-pull", name: t("commandUndo"), callback: () => void this.undoLastPull() });

		this.app.workspace.onLayoutReady(() => {
			if (this.data.checkOnStartup && this.isConfigured()) window.setTimeout(() => void this.backgroundCheck(), 3000);
			this.scheduleChecks();
		});
	}

	// ------------------------------------------------------------ settings

	private async loadPluginData(): Promise<void> {
		const raw = ((await this.loadData()) ?? {}) as Partial<PluginData>;
		this.data = {
			...structuredClone(DEFAULTS),
			...raw,
			shared: normalizeSettings(raw.shared),
			localExclude: Array.isArray(raw.localExclude) ? raw.localExclude : [],
			base: raw.base && typeof raw.base === "object" ? { location: raw.base.location ?? "", items: raw.base.items ?? {} } : { location: "", items: {} },
		};
		if (this.data.kind !== "folder") this.data.kind = "github";
		// A new vault starts with the store used last on this machine.
		if (!hasLocation(this.data)) {
			const last = this.savedStores()[0];
			if (last) this.useStore(last);
		}
	}

	/** Stores used by any vault on this machine, most recent first. */
	savedStores(): StoreRef[] {
		try {
			const raw = JSON.parse(window.localStorage.getItem(STORES_KEY) ?? "null") as unknown;
			if (Array.isArray(raw)) {
				return raw
					.filter((x): x is StoreRef => !!x && typeof x === "object")
					.map((x) => ({ kind: x.kind === "folder" ? "folder" : "github", repo: x.repo ?? "", branch: x.branch || "main", folder: x.folder ?? "", path: x.path ?? "" }) as StoreRef)
					.filter(hasLocation);
			}
			// Older versions remembered one GitHub location.
			const last = JSON.parse(window.localStorage.getItem(LAST_REMOTE_KEY) ?? "null") as Partial<StoreRef> | null;
			if (last?.repo) return [{ kind: "github", repo: last.repo, branch: last.branch || "main", folder: last.folder ?? "", path: "" }];
		} catch {
			// nothing remembered
		}
		return [];
	}

	useStore(s: StoreRef): void {
		Object.assign(this.data, { kind: s.kind, repo: s.repo, branch: s.branch || "main", folder: s.folder, path: s.path });
	}

	forgetStore(s: StoreRef): void {
		window.localStorage.setItem(STORES_KEY, JSON.stringify(this.savedStores().filter((x) => !sameStore(x, s))));
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.data);
		const d = this.data;
		if (hasLocation(d)) {
			const cur: StoreRef = { kind: d.kind, repo: d.repo, branch: d.branch, folder: d.folder, path: d.path };
			const list = [cur, ...this.savedStores().filter((x) => !sameStore(x, cur))].slice(0, 20);
			window.localStorage.setItem(STORES_KEY, JSON.stringify(list));
		}
	}

	scheduleChecks(): void {
		if (this.intervalId !== null) window.clearInterval(this.intervalId);
		this.intervalId = null;
		const minutes = this.data.checkIntervalMin;
		if (minutes > 0) {
			this.intervalId = this.registerInterval(window.setInterval(() => void this.backgroundCheck(), minutes * 60 * 1000));
		}
	}

	tokens(): TokenStore {
		const secrets = this.app.secretStorage;
		return new TokenStore(appStorage, systemCipher(), {
			get: () => secrets.getSecret(TOKEN_SECRET),
			set: (v) => secrets.setSecret(TOKEN_SECRET, v),
		});
	}

	getToken(): string | null {
		return this.tokens().get();
	}

	setToken(value: string): void {
		this.tokens().set(value);
	}

	isConfigured(): boolean {
		if (this.data.kind === "folder") return !!this.data.path.trim();
		return !!parseRepo(this.data.repo) && !!this.getToken();
	}

	/** Identifies the profile the base belongs to; a different location starts from an empty base. */
	location(): string {
		if (this.data.kind === "folder") return `folder:${this.data.path.trim().replace(/[\\/]+$/, "")}`;
		const r = parseRepo(this.data.repo);
		return `${r ? `${r.owner}/${r.name}`.toLowerCase() : ""}#${this.data.branch.trim() || "main"}#${this.data.folder.trim().replace(/^\/+|\/+$/g, "")}`;
	}

	currentBase(): Base {
		return this.data.base.location === this.location() ? this.data.base.items : {};
	}

	async storeBase(items: Base): Promise<void> {
		this.data.base = { location: this.location(), items };
		await this.saveSettings();
	}

	client(): GitHubClient {
		const r = parseRepo(this.data.repo);
		const token = this.getToken();
		if (!r || !token) throw new Error(t("notConfigured"));
		return new GitHubClient(obsidianHttp, r.owner, r.name, token);
	}

	store(): ProfileStore {
		if (this.data.kind === "folder") {
			if (!this.data.path.trim()) throw new Error(t("notConfigured"));
			return new FolderStore(nodeDisk(), this.data.path.trim());
		}
		return new GitHubStore(this.client(), this.data.branch.trim() || "main", this.data.folder);
	}

	engine(): SyncEngine {
		return new SyncEngine(
			{ fs: adapterFs(this.app.vault.adapter), http: obsidianHttp, host: appHost(this.app), store: this.store(), catalog: this.catalog },
			{
				configDir: this.app.vault.configDir,
				selfId: this.manifest.id,
				vaultName: this.app.vault.getName(),
				localExclude: this.data.localExclude,
				shared: this.data.shared,
			},
		);
	}

	backups(): BackupStore {
		return new BackupStore(adapterFs(this.app.vault.adapter), joinPath(this.app.vault.configDir, "plugins", this.manifest.id, "backups"));
	}

	// ------------------------------------------------------------ operations

	private async exclusive<T>(task: () => Promise<T>): Promise<T> {
		while (this.busy) await new Promise((r) => window.setTimeout(r, 200));
		this.busy = true;
		try {
			return await task();
		} finally {
			this.busy = false;
		}
	}

	async compare(): Promise<SyncStatus> {
		return this.exclusive(async () => {
			this.setStatusText(t("statusChecking"));
			try {
				const status = await this.engine().compare(this.currentBase());
				const settled = status.result.settledBase;
				if (JSON.stringify(settled) !== JSON.stringify(this.currentBase())) await this.storeBase(settled);
				this.lastStatus = status;
				this.setStatusText();
				return status;
			} catch (e) {
				this.lastStatus = null;
				this.setStatusText(t("statusError"));
				throw e;
			}
		});
	}

	/** Apply the profile's side of `changes`. The caller reloads Obsidian afterwards. */
	async pull(status: SyncStatus, changes: Change[], onProgress?: PullProgress): Promise<PullResult> {
		return this.exclusive(async () => {
			const r = await this.engine().pull(status, changes, status.result.settledBase, onProgress);
			if (r.shared) this.data.shared = r.shared;
			await this.storeBase(r.base);
			this.lastStatus = null;
			return r;
		});
	}

	async push(status: SyncStatus, changes: Change[]): Promise<PushResult> {
		return this.exclusive(async () => {
			const r = await this.engine().push(status, changes, status.result.settledBase);
			await this.storeBase(r.base);
			this.lastStatus = null;
			return r;
		});
	}

	/** Push first, then pull on top of the pushed base, so neither step undoes the other. */
	async syncAll(
		status: SyncStatus,
		out: Change[],
		incoming: Change[],
		onProgress?: PullProgress,
	): Promise<{ push: PushResult | null; pull: PullResult | null }> {
		return this.exclusive(async () => {
			let base = status.result.settledBase;
			let push: PushResult | null = null;
			let pull: PullResult | null = null;
			if (out.length > 0) {
				push = await this.engine().push(status, out, base);
				base = push.base;
				await this.storeBase(base);
			}
			if (incoming.length > 0) {
				pull = await this.engine().pull(status, incoming, base, onProgress);
				if (pull.shared) this.data.shared = pull.shared;
				await this.storeBase(pull.base);
			}
			this.lastStatus = null;
			return { push, pull };
		});
	}

	async undoLastPull(): Promise<void> {
		const list = await this.backups().list();
		if (list.length === 0) {
			new Notice(t("noBackup"));
			return;
		}
		if (!window.confirm(t("undoConfirm"))) return;
		await this.exclusive(async () => {
			const base = await this.backups().restoreLatest();
			if (base) await this.storeBase(base);
		});
		new Notice(t("undone"));
		window.setTimeout(() => this.reload(), 800);
	}

	reload(): void {
		reloadApp(this.app);
	}

	// ------------------------------------------------------------ ui

	openModal(): void {
		new SyncModal(this.app, this).open();
	}

	setStatusText(override?: string): void {
		if (!this.statusEl) return;
		let text = override;
		if (!text) {
			if (!this.isConfigured()) text = t("statusNotConfigured");
			else if (!this.lastStatus) text = t("profile");
			else {
				const { incoming, outgoing, conflicts } = this.lastStatus.result;
				if (incoming.length + outgoing.length + conflicts.length === 0) text = t("statusInSync");
				else {
					const parts = [`${t("profile")}:`];
					if (incoming.length) parts.push(`↓${incoming.length}`);
					if (outgoing.length) parts.push(`↑${outgoing.length}`);
					if (conflicts.length) parts.push(`⚠${conflicts.length}`);
					text = parts.join(" ");
				}
			}
		}
		this.statusEl.setText(text);
	}

	private async backgroundCheck(): Promise<void> {
		if (!this.isConfigured() || this.busy) return;
		try {
			const status = await this.compare();
			const n = status.result.incoming.length + status.result.conflicts.length;
			const head = status.remote.head?.version ?? null;
			if (n > 0 && head !== this.notifiedHead) {
				this.notifiedHead = head;
				const frag = createFragment((f) => {
					f.createDiv({ text: t("updateNotice", { n }) });
					f.createEl("button", { text: t("view"), cls: "mod-cta vps-notice-btn" }).addEventListener("click", () => this.openModal());
				});
				new Notice(frag, 15000);
			}
		} catch (e) {
			console.warn("[vault-profile-sync] background check failed", e);
		}
	}
}
