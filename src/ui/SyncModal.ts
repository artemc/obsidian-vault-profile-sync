/**
 * The one window of the plugin: what is incoming, outgoing and in conflict,
 * and the Pull / Push / Sync all buttons.
 */

import { Modal, Notice, setIcon, type App } from "obsidian";
import type { Change } from "../core/classify";
import type { SyncStatus } from "../engine/sync";
import { storeLabel } from "../core/stores";
import type VaultProfileSync from "../main";
import { RemoteMovedError } from "../remote/github";
import { DiffModal, type Direction } from "./DiffModal";
import { t } from "./i18n";
import { changeDetail, itemLabel } from "./labels";

type ConflictChoice = "skip" | "mine" | "theirs";

export class SyncModal extends Modal {
	private status: SyncStatus | null = null;
	private selected = new Set<string>();
	private choice = new Map<string, ConflictChoice>();
	private footerEl: HTMLElement | null = null;

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
		const { incoming, outgoing, conflicts } = this.status.result;
		this.selected = new Set([...incoming, ...outgoing].map((c) => c.key));
		this.choice = new Map(conflicts.map((c) => [c.key, "skip"]));
		this.render();
	}

	private render(): void {
		const status = this.status!;
		const { contentEl } = this;
		const { incoming, outgoing, conflicts } = status.result;
		contentEl.empty();

		const head = contentEl.createDiv({ cls: "vps-head" });
		head.createDiv({ cls: "vps-repo", text: storeLabel(this.plugin.data) });
		const c = status.remote.head;
		head.createDiv({
			cls: "vps-muted",
			text: !c ? t("noCommits") : c.message ? `${t("headCommit")}: ${c.message.split("\n")[0]} · ${new Date(c.date ?? "").toLocaleString()}` : "",
		});

		const all = [...incoming, ...outgoing, ...conflicts];
		if (all.length === 0) {
			contentEl.createDiv({ cls: "vps-insync", text: t("inSync") });
			this.excludedSection();
			return;
		}

		const fresh = !!c && all.every((x) => x.base === null) && incoming.length + conflicts.length > 0;
		if (fresh) {
			const banner = contentEl.createDiv({ cls: "vps-banner" });
			banner.createDiv({ text: t("freshVault") });
			banner.createEl("button", { text: t("takeAll"), cls: "mod-cta" }).addEventListener("click", () => {
				for (const x of incoming) this.selected.add(x.key);
				for (const x of conflicts) this.choice.set(x.key, "theirs");
				void this.run("pull");
			});
		}

		this.section(t("incoming"), t("incomingHint"), "arrow-down", incoming, "in");
		this.section(t("outgoing"), t("outgoingHint"), "arrow-up", outgoing, "out");
		this.section(t("conflicts"), t("conflictsHint"), "alert-triangle", conflicts, "conflict");

		this.excludedSection();

		this.footerEl = contentEl.createDiv({ cls: "vps-footer" });
		this.renderFooter();
	}

	private section(title: string, hint: string, icon: string, changes: Change[], dir: Direction): void {
		const sec = this.contentEl.createDiv({ cls: "vps-section" });
		const h = sec.createDiv({ cls: "vps-section-head" });
		setIcon(h.createSpan({ cls: "vps-section-icon" }), icon);
		h.createSpan({ cls: "vps-section-title", text: `${title} (${changes.length})` });
		h.createSpan({ cls: "vps-muted", text: ` - ${hint}` });
		if (changes.length === 0) {
			sec.createDiv({ cls: "vps-muted vps-empty", text: t("nothing") });
			return;
		}
		if (dir !== "conflict" && changes.length > 1) {
			const bulk = h.createSpan({ cls: "vps-bulk" });
			bulk.createEl("a", { text: t("selectAll") }).addEventListener("click", () => {
				changes.forEach((c) => this.selected.add(c.key));
				this.render();
			});
			bulk.createSpan({ text: " / " });
			bulk.createEl("a", { text: t("selectNone") }).addEventListener("click", () => {
				changes.forEach((c) => this.selected.delete(c.key));
				this.render();
			});
		}
		if (dir === "conflict" && changes.length > 1) {
			const bulk = h.createSpan({ cls: "vps-bulk" });
			bulk.createEl("a", { text: t("conflictMine") }).addEventListener("click", () => {
				changes.forEach((c) => this.choice.set(c.key, "mine"));
				this.render();
			});
			bulk.createSpan({ text: " / " });
			bulk.createEl("a", { text: t("conflictTheirs") }).addEventListener("click", () => {
				changes.forEach((c) => this.choice.set(c.key, "theirs"));
				this.render();
			});
		}
		for (const change of changes) this.row(sec, change, dir);
	}

	private row(parent: HTMLElement, change: Change, dir: Direction): void {
		const row = parent.createDiv({ cls: "vps-row" });
		if (dir === "conflict") {
			const select = row.createEl("select", { cls: "dropdown vps-choice" });
			for (const [value, label] of [
				["skip", t("conflictSkip")],
				["mine", t("conflictMine")],
				["theirs", t("conflictTheirs")],
			] as const) {
				select.createEl("option", { value, text: label });
			}
			select.value = this.choice.get(change.key) ?? "skip";
			select.addEventListener("change", () => {
				this.choice.set(change.key, select.value as ConflictChoice);
				this.renderFooter();
			});
		} else {
			const box = row.createEl("input", { type: "checkbox" });
			box.checked = this.selected.has(change.key);
			box.addEventListener("change", () => {
				if (box.checked) this.selected.add(change.key);
				else this.selected.delete(change.key);
				this.renderFooter();
			});
		}
		const text = row.createDiv({ cls: "vps-row-text" });
		text.createDiv({ cls: "vps-row-label", text: itemLabel(change.key) });
		text.createDiv({ cls: "vps-row-detail", text: changeDetail(change, dir) });

		const diffBtn = row.createEl("button", { text: t("diff") });
		diffBtn.addEventListener("click", () => new DiffModal(this.app, this.plugin, this.status!, change, dir).open());
		if (change.key !== "settings:sync") {
			const ex = row.createEl("button", { cls: "clickable-icon", attr: { "aria-label": t("excludeHere") } });
			setIcon(ex, "eye-off");
			ex.addEventListener("click", () => void this.excludeHere(change.key));
		}
	}

	/** What this vault excludes stays listed, so it can be synced again from here. */
	private excludedSection(): void {
		const keys = this.plugin.data.localExclude;
		if (keys.length === 0) return;
		const sec = this.contentEl.createDiv({ cls: "vps-section vps-excluded" });
		const h = sec.createDiv({ cls: "vps-section-head" });
		setIcon(h.createSpan({ cls: "vps-section-icon" }), "eye-off");
		h.createSpan({ cls: "vps-section-title", text: `${t("excludedHere")} (${keys.length})` });
		h.createSpan({ cls: "vps-muted", text: ` - ${t("excludedHint")}` });
		for (const key of keys) {
			const row = sec.createDiv({ cls: "vps-row vps-row-excluded" });
			row.createDiv({ cls: "vps-row-text" }).createDiv({ cls: "vps-row-label", text: /[*?]/.test(key) ? key : itemLabel(key) });
			const btn = row.createEl("button", { cls: "clickable-icon", attr: { "aria-label": t("includeHere") } });
			setIcon(btn, "eye");
			btn.addEventListener("click", () => void this.includeHere(key));
		}
	}

	private async includeHere(key: string): Promise<void> {
		this.plugin.data.localExclude = this.plugin.data.localExclude.filter((k) => k !== key);
		await this.plugin.saveSettings();
		await this.load();
	}

	private picks(): { pull: Change[]; push: Change[] } {
		const { incoming, outgoing, conflicts } = this.status!.result;
		return {
			pull: [...incoming.filter((c) => this.selected.has(c.key)), ...conflicts.filter((c) => this.choice.get(c.key) === "theirs")],
			push: [...outgoing.filter((c) => this.selected.has(c.key)), ...conflicts.filter((c) => this.choice.get(c.key) === "mine")],
		};
	}

	private renderFooter(): void {
		if (!this.footerEl) return;
		const f = this.footerEl;
		f.empty();
		const { pull, push } = this.picks();
		const btn = (label: string, n: number, kind: "pull" | "push" | "sync", cta = false) => {
			const b = f.createEl("button", { text: n > 0 ? `${label} (${n})` : label, cls: cta ? "mod-cta" : "" });
			b.disabled = n === 0;
			b.addEventListener("click", () => void this.run(kind));
		};
		btn(t("pull"), pull.length, "pull");
		btn(t("push"), push.length, "push");
		btn(t("syncAll"), pull.length + push.length, "sync", true);
		if (pull.length > 0) f.createDiv({ cls: "vps-muted vps-footer-hint", text: t("reloadHint") });
	}

	private async excludeHere(key: string): Promise<void> {
		if (!this.plugin.data.localExclude.includes(key)) this.plugin.data.localExclude.push(key);
		await this.plugin.saveSettings();
		await this.load();
	}

	private async run(kind: "pull" | "push" | "sync"): Promise<void> {
		const status = this.status!;
		const { pull, push } = this.picks();
		this.message(t("working"));
		try {
			if (kind === "push") {
				const r = await this.plugin.push(status, push);
				new Notice(t("pushed", { n: r.pushed.length }));
				await this.load();
				return;
			}
			const progress = (done: number, total: number, key: string) => {
				this.message(t("pullProgress", { done: done + 1, total, item: itemLabel(key) }));
			};
			const r =
				kind === "pull"
					? { push: null, pull: await this.plugin.pull(status, pull, progress) }
					: await this.plugin.syncAll(status, push, pull, progress);
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
