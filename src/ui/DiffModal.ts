/** Shows how one item differs between the vault and the profile. */

import { Modal, type App } from "obsidian";
import type { Change } from "../core/classify";
import { itemDiff } from "../core/diff";
import type { SyncStatus } from "../engine/sync";
import type VaultProfileSync from "../main";
import { t } from "./i18n";
import { itemLabel } from "./labels";

export type Direction = "in" | "out" | "conflict";

export class DiffModal extends Modal {
	constructor(
		app: App,
		private readonly plugin: VaultProfileSync,
		private readonly status: SyncStatus,
		private readonly change: Change,
		private readonly direction: Direction,
	) {
		super(app);
	}

	onOpen(): void {
		this.modalEl.addClass("vps-diff-modal");
		this.titleEl.setText(itemLabel(this.change.key));
		this.contentEl.createDiv({ cls: "vps-muted", text: t("loading") });
		void this.load();
	}

	private async load(): Promise<void> {
		const { contentEl } = this;
		try {
			const engine = this.plugin.engine();
			const local = await engine.sideText(this.status, this.change, "local");
			const remote = await engine.sideText(this.status, this.change, "remote");
			const fromVault = this.direction === "in";
			const [before, after] = fromVault ? [local, remote] : [remote, local];
			const [beforeLabel, afterLabel] = fromVault ? [t("inVault"), t("inProfile")] : [t("inProfile"), t("inVault")];
			contentEl.empty();
			const head = contentEl.createDiv({ cls: "vps-diff-head" });
			head.createSpan({ cls: "vps-removed", text: `${beforeLabel}${before === undefined ? ` ${t("absent")}` : ""}` });
			head.createSpan({ text: "  →  " });
			head.createSpan({ cls: "vps-added", text: `${afterLabel}${after === undefined ? ` ${t("absent")}` : ""}` });

			const diff = itemDiff(before, after);
			if (diff.rows.length === 0) {
				contentEl.createDiv({ cls: "vps-muted", text: t("noDifference") });
				return;
			}
			const box = contentEl.createDiv({ cls: "vps-diff" });
			if (diff.kind === "json") {
				for (const row of diff.rows) {
					const line = box.createDiv({ cls: "vps-diff-row" });
					line.createSpan({ cls: "vps-diff-path", text: row.path });
					if (row.before !== undefined) line.createSpan({ cls: "vps-removed", text: row.before });
					if (row.before !== undefined && row.after !== undefined) line.createSpan({ text: " → " });
					if (row.after !== undefined) line.createSpan({ cls: "vps-added", text: row.after });
				}
			} else {
				for (const row of diff.rows) {
					const sign = row.type === "added" ? "+ " : row.type === "removed" ? "- " : "  ";
					box.createDiv({
						cls: `vps-diff-line ${row.type === "added" ? "vps-added" : row.type === "removed" ? "vps-removed" : ""}`,
						text: sign + row.text,
					});
				}
			}
		} catch (e) {
			contentEl.empty();
			contentEl.createDiv({ cls: "vps-error", text: e instanceof Error ? e.message : String(e) });
		}
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
