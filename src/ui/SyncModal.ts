/**
 * The one window of the plugin, in two panels: this vault on the left, the profile
 * on the right, and in the middle which way each item goes. Items are grouped
 * (Obsidian settings, core plugins, community plugins with their settings, ...)
 * and colored by how each side differs from the base. A row opens to show the
 * difference key by key; a JSON file can be merged there, key by key.
 */

import { Modal, Notice, setIcon, type App } from "obsidian";
import { defaultDirection, sideStates, type Change, type Direction, type SideState } from "../core/classify";
import { itemDiff, lineDiff } from "../core/diff";
import { buildTree, corePluginIds, type GroupId, type TreeGroup, type TreeRow } from "../core/groups";
import { mergedChange, prepareMerge, rowId, type JsonMerge, type MergeSide } from "../core/merge";
import { splitKey } from "../core/model";
import { storeLabel } from "../core/stores";
import type { SyncStatus } from "../engine/sync";
import type VaultProfileSync from "../main";
import { RemoteMovedError } from "../remote/github";
import { t } from "./i18n";
import { actionDetail, itemLabel, itemVersion, shortName } from "./labels";

const ONLY_DIFF_KEY = "vault-profile-sync:only-diff";

const GROUP_TITLE: Record<GroupId, Parameters<typeof t>[0]> = {
	obsidian: "gObsidian",
	core: "gCore",
	community: "gCommunity",
	snippets: "gSnippets",
	themes: "gThemes",
	other: "gOther",
	sync: "gSync",
};

const STATE_TEXT: Record<SideState, Parameters<typeof t>[0] | null> = {
	same: null,
	edited: "stEdited",
	added: "stAdded",
	removed: "stRemoved",
	absent: "stAbsent",
	differs: "stDiffers",
};

const DIRECTIONS: { dir: Direction; icon: string; label: Parameters<typeof t>[0] }[] = [
	{ dir: "pull", icon: "arrow-left", label: "dirPull" },
	{ dir: "skip", icon: "minus", label: "dirSkip" },
	{ dir: "push", icon: "arrow-right", label: "dirPush" },
	{ dir: "merge", icon: "git-merge", label: "dirMerge" },
];

/** Both sides of one item as text, loaded when its row is opened. */
interface Loaded {
	local?: string;
	remote?: string;
	merge: JsonMerge | null;
}

function differs(c: Change | null): c is Change {
	return !!c && c.status !== "same";
}

function canMerge(c: Change): boolean {
	const { kind } = splitKey(c.key);
	return (kind === "config" || kind === "plugin-data") && !!c.local && !!c.remote && c.status !== "same";
}

function readOnlyDiff(): boolean {
	try {
		return window.localStorage.getItem(ONLY_DIFF_KEY) === "1";
	} catch {
		return false;
	}
}

function writeOnlyDiff(value: boolean): void {
	try {
		window.localStorage.setItem(ONLY_DIFF_KEY, value ? "1" : "0");
	} catch {
		// Only a convenience.
	}
}

export class SyncModal extends Modal {
	private status: SyncStatus | null = null;
	private dirs = new Map<string, Direction>();
	private picks = new Map<string, Map<string, MergeSide>>();
	private loaded = new Map<string, Loaded | { error: string }>();
	private expanded = new Set<string>();
	private groupOpen = new Map<GroupId, boolean>();
	private onlyDiff = readOnlyDiff();

	constructor(
		app: App,
		private readonly plugin: VaultProfileSync,
	) {
		super(app);
	}

	onOpen(): void {
		this.modalEl.addClass("vps-modal");
		this.titleEl.setText(t("name"));
		void this.load();
	}

	onClose(): void {
		this.contentEl.empty();
	}

	private message(text: string, cls = "vps-muted"): void {
		this.contentEl.empty();
		this.contentEl.createDiv({ cls, text });
	}

	private async load(): Promise<void> {
		if (!this.plugin.isConfigured()) {
			this.message(t("notConfigured"));
			const btn = this.contentEl.createEl("button", { text: t("openSettings"), cls: "mod-cta" });
			btn.addEventListener("click", () => {
				this.close();
				const setting = (this.app as unknown as { setting?: { open(): void; openTabById(id: string): void } }).setting;
				setting?.open();
				setting?.openTabById(this.plugin.manifest.id);
			});
			return;
		}
		this.message(t("loading"));
		try {
			this.status = await this.plugin.compare();
		} catch (e) {
			this.message(e instanceof Error ? e.message : String(e), "vps-error");
			this.contentEl.createEl("button", { text: t("retry") }).addEventListener("click", () => void this.load());
			return;
		}
		this.dirs = new Map(this.differing().map((c) => [c.key, defaultDirection(c)]));
		this.picks.clear();
		this.loaded.clear();
		this.expanded.clear();
		this.render();
	}

	private differing(): Change[] {
		const { incoming, outgoing, conflicts } = this.status!.result;
		return [...incoming, ...outgoing, ...conflicts];
	}

	private dir(c: Change): Direction {
		return this.dirs.get(c.key) ?? "skip";
	}

	private setDir(c: Change, dir: Direction): void {
		this.dirs.set(c.key, dir);
		if (dir === "merge") {
			this.expanded.add(c.key);
			void this.ensureLoaded(c);
		}
		this.render();
	}

	// ------------------------------------------------------------ layout

	private render(): void {
		const status = this.status!;
		const { contentEl, modalEl } = this;
		const scroll = [modalEl.scrollTop, contentEl.scrollTop];
		contentEl.empty();

		const head = contentEl.createDiv({ cls: "vps-head" });
		head.createDiv({ cls: "vps-repo", text: storeLabel(this.plugin.data) });
		const c = status.remote.head;
		head.createDiv({
			cls: "vps-muted",
			text: !c ? t("noCommits") : c.message ? `${t("headCommit")}: ${c.message.split("\n")[0]} · ${new Date(c.date ?? "").toLocaleString()}` : "",
		});

		const differing = this.differing();
		if (differing.length === 0) contentEl.createDiv({ cls: "vps-insync", text: t("inSync") });

		const { incoming, conflicts } = status.result;
		const fresh = !!c && differing.length > 0 && differing.every((x) => x.base === null) && incoming.length + conflicts.length > 0;
		if (fresh) {
			const banner = contentEl.createDiv({ cls: "vps-banner" });
			banner.createDiv({ text: t("freshVault") });
			banner.createEl("button", { text: t("takeAll"), cls: "mod-cta" }).addEventListener("click", () => {
				for (const x of [...incoming, ...conflicts]) this.dirs.set(x.key, "pull");
				void this.run();
			});
		}

		this.toolbar(differing);

		const grid = contentEl.createDiv({ cls: "vps-grid" });
		const colHead = grid.createDiv({ cls: "vps-trow vps-colhead" });
		colHead.createDiv({ cls: "vps-cell vps-left", text: `${t("colVault")}: ${this.app.vault.getName()}` });
		colHead.createDiv({ cls: "vps-cell vps-center" });
		colHead.createDiv({ cls: "vps-cell vps-right", text: t("colProfile") });

		for (const group of this.tree()) this.group(grid, group);

		this.patternSection();

		this.footer();
		modalEl.scrollTop = scroll[0];
		contentEl.scrollTop = scroll[1];
	}

	private tree(): TreeGroup[] {
		const { result, local } = this.status!;
		const all = [...this.differing(), ...result.same];
		const coreText = local.snapshot.get("config:core-plugins.json")?.text;
		const excluded = this.plugin.data.localExclude.filter((k) => k.includes(":") && !/[*?]/.test(k));
		return buildTree(all, excluded, corePluginIds(coreText));
	}

	private toolbar(differing: Change[]): void {
		const bar = this.contentEl.createDiv({ cls: "vps-toolbar" });
		const label = bar.createEl("label", { cls: "vps-toggle" });
		const box = label.createEl("input", { type: "checkbox" });
		box.checked = this.onlyDiff;
		label.appendText(` ${t("onlyDiff")}`);
		box.addEventListener("change", () => {
			this.onlyDiff = box.checked;
			writeOnlyDiff(this.onlyDiff);
			this.render();
		});
		if (differing.length === 0) return;
		const bulk = bar.createDiv({ cls: "vps-bulk" });
		const link = (text: string, apply: (c: Change) => Direction) => {
			bulk.createEl("a", { text }).addEventListener("click", () => {
				for (const c of differing) this.dirs.set(c.key, apply(c));
				this.render();
			});
		};
		link(t("bulkPull"), () => "pull");
		link(t("bulkPush"), () => "push");
		link(t("bulkReset"), defaultDirection);
	}

	/** Excluded items always stay listed: they are what this vault chose not to compare. */
	private visible(row: TreeRow): boolean {
		if (!this.onlyDiff || row.change === null) return true;
		return differs(row.change) || row.children.some((r) => this.visible(r));
	}

	private group(grid: HTMLElement, group: TreeGroup): void {
		const rows = group.rows.filter((r) => this.visible(r));
		if (rows.length === 0) return;
		const flat = group.rows.flatMap((r) => [r, ...r.children]);
		const changed = flat.map((r) => r.change).filter(differs);
		const same = flat.filter((r) => r.change && r.change.status === "same").length;
		const locked = flat.some((r) => r.change === null);
		const open = this.groupOpen.get(group.id) ?? (changed.length > 0 || (this.onlyDiff && locked));

		const head = grid.createDiv({ cls: "vps-trow vps-group" });
		const toggle = () => {
			this.groupOpen.set(group.id, !open);
			this.render();
		};
		const title = (cell: HTMLElement) => {
			cell.addClass("vps-group-title");
			setIcon(cell.createSpan({ cls: "vps-chevron" }), open ? "chevron-down" : "chevron-right");
			cell.createSpan({ text: t(GROUP_TITLE[group.id]) });
			if (changed.length > 0) cell.createSpan({ cls: "vps-badge", text: String(changed.length) });
			if (!open && same > 0) cell.createSpan({ cls: "vps-muted", text: ` ${t("inSyncCount", { n: same })}` });
			cell.addEventListener("click", toggle);
		};
		const left = head.createDiv({ cls: "vps-cell vps-left" });
		title(left);
		if (group.id === "other") left.createDiv({ cls: "vps-muted vps-group-hint", text: t("gOtherHint") });
		const center = head.createDiv({ cls: "vps-cell vps-center" });
		if (changed.length > 0) {
			const dirs = new Set(changed.map((c) => this.dir(c)));
			const current = dirs.size === 1 ? [...dirs][0] : null;
			this.segmented(center, current, false, (dir) => {
				for (const c of changed) this.dirs.set(c.key, dir);
				this.render();
			});
		}
		title(head.createDiv({ cls: "vps-cell vps-right" }));

		if (!open) return;
		for (const row of rows) {
			this.row(grid, row, 0);
			for (const child of row.children) if (this.visible(child)) this.row(grid, child, 1);
		}
	}

	private segmented(parent: HTMLElement, current: Direction | null, merge: boolean, onPick: (dir: Direction) => void): void {
		const seg = parent.createDiv({ cls: "vps-seg" });
		for (const d of DIRECTIONS) {
			if (d.dir === "merge" && !merge) continue;
			const b = seg.createEl("button", { cls: `vps-seg-btn vps-seg-${d.dir}`, attr: { "aria-label": t(d.label) } });
			if (d.dir === current) b.addClass("is-active");
			setIcon(b, d.icon);
			b.addEventListener("click", () => onPick(d.dir));
		}
	}

	private sideCell(cell: HTMLElement, key: string, item: Change["local"], state: SideState): void {
		const name = cell.createSpan({ cls: `vps-name vps-st-${state}` });
		name.setText(shortName(key));
		const v = itemVersion(item);
		if (v) name.createSpan({ cls: "vps-version", text: ` ${v}` });
		if (item?.plugin && !item.plugin.enabled) name.createSpan({ cls: "vps-version", text: ` (${t("stOff")})` });
		const st = STATE_TEXT[state];
		if (st) name.createSpan({ cls: "vps-state", text: ` (${t(st)})` });
		name.setAttr("title", itemLabel(key));
	}

	private row(grid: HTMLElement, row: TreeRow, depth: number): void {
		const change = row.change;
		const tr = grid.createDiv({ cls: `vps-trow vps-item${depth > 0 ? " vps-child" : ""}` });
		const left = tr.createDiv({ cls: "vps-cell vps-left" });
		const center = tr.createDiv({ cls: "vps-cell vps-center" });
		const right = tr.createDiv({ cls: "vps-cell vps-right" });

		const excluded = change === null;
		if (row.key !== "settings:sync") {
			const lock = left.createEl("button", {
				cls: `clickable-icon vps-lock${excluded ? " is-locked" : ""}`,
				attr: { "aria-label": excluded ? t("includeHere") : t("excludeHere") },
			});
			setIcon(lock, excluded ? "lock" : "lock-open");
			lock.addEventListener("click", () => void (excluded ? this.includeHere(row.key) : this.excludeHere(row.key)));
		} else left.createSpan({ cls: "vps-lock-space" });

		if (excluded) {
			left.createSpan({ cls: "vps-name vps-st-excluded", text: shortName(row.key) }).setAttr("title", itemLabel(row.key));
			center.createDiv({ cls: "vps-muted", text: t("excludedRow") });
			return;
		}

		const states = sideStates(change);
		const changed = differs(change);
		if (changed) {
			const open = this.expanded.has(row.key);
			const chev = left.createSpan({ cls: "vps-chevron clickable-icon", attr: { "aria-label": t("showDiff") } });
			setIcon(chev, open ? "chevron-down" : "chevron-right");
			chev.addEventListener("click", () => {
				if (open) this.expanded.delete(row.key);
				else {
					this.expanded.add(row.key);
					void this.ensureLoaded(change);
				}
				this.render();
			});
		} else left.createSpan({ cls: "vps-chevron-space" });
		this.sideCell(left, row.key, change.local, states.local);
		this.sideCell(right, row.key, change.remote, states.remote);

		if (!changed) return;
		const dir = this.dir(change);
		this.segmented(center, dir, canMerge(change), (d) => this.setDir(change, d));
		const conflict = dir === "skip" && change.status === "conflict";
		center.createDiv({ cls: `vps-action vps-action-${conflict ? "conflict" : dir}`, text: this.actionText(change, dir) });

		if (this.expanded.has(row.key)) this.detail(grid, change);
	}

	private actionText(change: Change, dir: Direction): string {
		if (dir === "skip" && change.status === "conflict") return t("doConflict");
		if (dir !== "merge") return actionDetail(change, dir);
		const l = this.loaded.get(change.key);
		if (!l || "error" in l || !l.merge) return actionDetail(change, dir);
		const picks = this.picks.get(change.key);
		const b = l.merge.rows.filter((r) => picks?.get(rowId(r)) === "remote").length;
		return `${actionDetail(change, dir)}: ${t("mergeCount", { a: l.merge.rows.length - b, b })}`;
	}

	// ------------------------------------------------------------ difference and merge

	private async ensureLoaded(change: Change): Promise<void> {
		if (this.loaded.has(change.key)) return;
		try {
			const engine = this.plugin.engine();
			const local = await engine.sideText(this.status!, change, "local");
			const remote = await engine.sideText(this.status!, change, "remote");
			this.loaded.set(change.key, { local, remote, merge: prepareMerge(local, remote) });
		} catch (e) {
			this.loaded.set(change.key, { error: e instanceof Error ? e.message : String(e) });
		}
		if (this.status) this.render();
	}

	private detail(grid: HTMLElement, change: Change): void {
		const box = grid.createDiv({ cls: "vps-detail" });
		const l = this.loaded.get(change.key);
		if (!l) {
			box.createDiv({ cls: "vps-muted", text: t("loading") });
			return;
		}
		if ("error" in l) {
			box.createDiv({ cls: "vps-error", text: l.error });
			return;
		}
		const merging = this.dir(change) === "merge";
		if (merging && !l.merge) box.createDiv({ cls: "vps-error", text: t("notJson") });

		const diff = itemDiff(l.local, l.remote);
		if (diff.rows.length === 0) {
			box.createDiv({ cls: "vps-muted", text: t("noDifference") });
			return;
		}
		if (diff.kind === "text") {
			const lines = lineDiff(l.remote ?? "", l.local ?? "");
			box.createDiv({ cls: "vps-muted", text: t("textLegend") });
			const pre = box.createDiv({ cls: "vps-diff" });
			for (const row of lines) {
				if (row.type === "added" || row.type === "removed") {
					pre.createDiv({ cls: `vps-diff-line ${row.type === "added" ? "vps-added" : "vps-removed"}`, text: (row.type === "added" ? "+ " : "− ") + row.text });
				} else pre.createDiv({ cls: "vps-diff-line", text: `  ${row.text}` });
			}
			return;
		}

		const picks = this.picks.get(change.key) ?? new Map<string, MergeSide>();
		this.picks.set(change.key, picks);
		const canPick = merging && !!l.merge;
		if (canPick) {
			const bar = box.createDiv({ cls: "vps-merge-bar" });
			bar.createSpan({ cls: "vps-muted", text: t("mergeHint") });
			const all = (side: MergeSide) => () => {
				for (const r of diff.rows) picks.set(rowId(r), side);
				this.render();
			};
			const links = bar.createSpan({ cls: "vps-bulk" });
			links.createEl("a", { text: t("mergeAllVault") }).addEventListener("click", all("local"));
			links.createEl("a", { text: t("mergeAllProfile") }).addEventListener("click", all("remote"));
		}
		const table = box.createDiv({ cls: `vps-kv${canPick ? " is-merging" : ""}` });
		table.createDiv({ cls: "vps-kv-head" });
		table.createDiv({ cls: "vps-kv-head", text: t("colVault") });
		table.createDiv({ cls: "vps-kv-head", text: t("colProfile") });
		for (const row of diff.rows) {
			const id = rowId(row);
			const pick = picks.get(id) ?? "local";
			table.createDiv({ cls: "vps-kv-path", text: row.path });
			const cell = (side: MergeSide, value: string | undefined) => {
				const el = table.createDiv({ cls: `vps-kv-val vps-kv-${side}` });
				if (value === undefined) el.createSpan({ cls: "vps-faint", text: "-" });
				else el.setText(value);
				if (!canPick) return;
				el.toggleClass("is-picked", pick === side);
				el.addEventListener("click", () => {
					picks.set(id, side);
					this.render();
				});
			};
			cell("local", row.before);
			cell("remote", row.after);
		}
	}

	// ------------------------------------------------------------ exclusions

	/** Patterns from the settings that are not a single item stay listed here. */
	private patternSection(): void {
		const patterns = this.plugin.data.localExclude.filter((k) => !k.includes(":") || /[*?]/.test(k));
		if (patterns.length === 0) return;
		const sec = this.contentEl.createDiv({ cls: "vps-section vps-excluded" });
		const h = sec.createDiv({ cls: "vps-section-head" });
		setIcon(h.createSpan({ cls: "vps-section-icon" }), "lock");
		h.createSpan({ cls: "vps-section-title", text: `${t("excludedPatterns")} (${patterns.length})` });
		h.createSpan({ cls: "vps-muted", text: ` - ${t("excludedHint")}` });
		for (const key of patterns) {
			const row = sec.createDiv({ cls: "vps-row vps-row-excluded" });
			row.createDiv({ cls: "vps-row-text" }).createDiv({ cls: "vps-row-label", text: key });
			const btn = row.createEl("button", { cls: "clickable-icon", attr: { "aria-label": t("includeHere") } });
			setIcon(btn, "lock");
			btn.addEventListener("click", () => void this.includeHere(key));
		}
	}

	private async excludeHere(key: string): Promise<void> {
		if (!this.plugin.data.localExclude.includes(key)) this.plugin.data.localExclude.push(key);
		await this.plugin.saveSettings();
		await this.load();
	}

	private async includeHere(key: string): Promise<void> {
		this.plugin.data.localExclude = this.plugin.data.localExclude.filter((k) => k !== key);
		await this.plugin.saveSettings();
		await this.load();
	}

	// ------------------------------------------------------------ apply

	private counts(): { pull: number; push: number } {
		let pull = 0;
		let push = 0;
		for (const c of this.differing()) {
			const d = this.dir(c);
			if (d === "pull" || d === "merge") pull++;
			if (d === "push" || d === "merge") push++;
		}
		return { pull, push };
	}

	private footer(): void {
		const f = this.contentEl.createDiv({ cls: "vps-footer" });
		const { pull, push } = this.counts();
		f.createDiv({ cls: "vps-muted vps-footer-counts", text: t("applyCounts", { pull, push }) });
		const b = f.createEl("button", { text: t("apply"), cls: "mod-cta" });
		b.disabled = pull + push === 0;
		b.addEventListener("click", () => void this.run());
		if (pull > 0) f.createDiv({ cls: "vps-muted vps-footer-hint", text: t("reloadHint") });
	}

	/** The changes to pull and to push; a merge may go both ways (see mergedChange). */
	private async plan(): Promise<{ pull: Change[]; push: Change[] }> {
		const pull: Change[] = [];
		const push: Change[] = [];
		for (const c of this.differing()) {
			const d = this.dir(c);
			if (d === "pull") pull.push(c);
			else if (d === "push") push.push(c);
			else if (d === "merge") {
				const l = this.loaded.get(c.key);
				if (!l || "error" in l || !l.merge) continue;
				const m = await mergedChange(c, l.merge, this.picks.get(c.key) ?? new Map());
				if (m.pull) pull.push(m.change);
				if (m.push) push.push(m.change);
			}
		}
		return { pull, push };
	}

	private async run(): Promise<void> {
		const status = this.status!;
		const { pull, push } = await this.plan();
		if (pull.length + push.length === 0) {
			await this.load();
			return;
		}
		this.message(t("working"));
		try {
			const progress = (done: number, total: number, key: string) => {
				this.message(t("pullProgress", { done: done + 1, total, item: itemLabel(key) }));
			};
			const r = await this.plugin.syncAll(status, push, pull, progress);
			if (r.push) new Notice(t("pushed", { n: r.push.pushed.length }));
			const p = r.pull;
			if (!p) {
				await this.load();
				return;
			}
			if (p.failed.length === 0 && p.warnings.length === 0) {
				new Notice(t("pulledReload", { n: p.applied.length }));
				this.close();
				window.setTimeout(() => this.plugin.reload(), 800);
				return;
			}
			this.contentEl.empty();
			this.contentEl.createDiv({ text: t("pullResult", { n: p.applied.length }) });
			if (p.failed.length > 0) {
				this.contentEl.createDiv({ cls: "vps-error", text: t("pullFailed") });
				const ul = this.contentEl.createEl("ul");
				for (const f of p.failed) ul.createEl("li", { text: `${itemLabel(f.key)}: ${f.error}` });
			}
			if (p.warnings.length > 0) {
				this.contentEl.createDiv({ text: t("warnings") });
				const ul = this.contentEl.createEl("ul");
				for (const w of p.warnings) ul.createEl("li", { text: w });
			}
			if (p.applied.length > 0) {
				this.contentEl.createDiv({ cls: "vps-muted", text: t("reloadHint") });
				this.contentEl.createEl("button", { text: t("reloadNow"), cls: "mod-cta" }).addEventListener("click", () => this.plugin.reload());
			}
		} catch (e) {
			if (e instanceof RemoteMovedError) {
				new Notice(t("remoteMoved"));
				await this.load();
				return;
			}
			this.message(e instanceof Error ? e.message : String(e), "vps-error");
			this.contentEl.createEl("button", { text: t("retry") }).addEventListener("click", () => void this.load());
		}
	}
}
