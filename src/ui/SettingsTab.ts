/** Plugin settings: connection, update checks, exclusions, backups. */

import { PluginSettingTab, Setting, type App } from "obsidian";
import { parsePatternList } from "../core/exclude";
import { KEEP_BACKUPS } from "../engine/backup";
import type VaultProfileSync from "../main";
import { t } from "./i18n";

export class ProfileSettingTab extends PluginSettingTab {
	constructor(
		app: App,
		private readonly plugin: VaultProfileSync,
	) {
		super(app, plugin);
	}

	display(): void {
		const { containerEl, plugin } = this;
		const data = plugin.data;
		containerEl.empty();

		new Setting(containerEl).setName(t("sConnection")).setHeading();
		const locationBefore = plugin.location();
		const noteLocation = () => {
			if (plugin.location() !== locationBefore) locationNote.setText(t("sRepoChanged"));
		};
		new Setting(containerEl)
			.setName(t("sRepo"))
			.setDesc(t("sRepoDesc"))
			.addText((c) =>
				c
					.setPlaceholder("owner/obsidian-profile")
					.setValue(data.repo)
					.onChange(async (v) => {
						data.repo = v.trim();
						await plugin.saveSettings();
						noteLocation();
					}),
			);
		new Setting(containerEl).setName(t("sBranch")).addText((c) =>
			c
				.setPlaceholder("main")
				.setValue(data.branch)
				.onChange(async (v) => {
					data.branch = v.trim() || "main";
					await plugin.saveSettings();
					noteLocation();
				}),
		);
		new Setting(containerEl)
			.setName(t("sFolder"))
			.setDesc(t("sFolderDesc"))
			.addText((c) =>
				c.setValue(data.folder).onChange(async (v) => {
					data.folder = v.trim().replace(/^\/+|\/+$/g, "");
					await plugin.saveSettings();
					noteLocation();
				}),
			);
		const locationNote = containerEl.createDiv({ cls: "vps-muted vps-note" });

		const tokenSetting = new Setting(containerEl).setName(t("sToken")).setDesc(t(plugin.tokens().shared() ? "sTokenDescShared" : "sTokenDescVault"));
		tokenSetting.descEl.createEl("br");
		tokenSetting.descEl.createEl("a", { text: t("sTokenCreate"), href: "https://github.com/settings/personal-access-tokens/new" });
		tokenSetting.addText((c) => {
			c.inputEl.type = "password";
			c.setPlaceholder(plugin.getToken() ? `•••••• (${t("sTokenSaved")})` : "github_pat_…").onChange((v) => {
				if (v.trim()) plugin.setToken(v);
				plugin.setStatusText();
			});
		});
		tokenSetting.addExtraButton((b) =>
			b
				.setIcon("trash")
				.setTooltip(t("sTokenForget"))
				.onClick(() => {
					plugin.tokens().forget();
					plugin.setStatusText();
					this.display();
				}),
		);

		const testResult = containerEl.createDiv({ cls: "vps-note" });
		new Setting(containerEl).addButton((b) =>
			b.setButtonText(t("sTest")).onClick(async () => {
				testResult.setText(t("working"));
				testResult.className = "vps-note vps-muted";
				try {
					const repo = await plugin.client().getRepo();
					const empty = repo.empty ? t("sTestEmpty") : "";
					if (!repo.canPush) {
						testResult.setText(t("sTestNoPush"));
						testResult.className = "vps-note vps-error";
					} else if (!repo.isPrivate) {
						testResult.setText(t("sTestPublic") + empty);
						testResult.className = "vps-note vps-error";
					} else {
						testResult.setText(t("sTestOk") + empty);
						testResult.className = "vps-note vps-ok";
					}
				} catch (e) {
					testResult.setText(e instanceof Error ? e.message : String(e));
					testResult.className = "vps-note vps-error";
				}
			}),
		);

		new Setting(containerEl).setName(t("sChecks")).setHeading();
		new Setting(containerEl).setName(t("sOnStartup")).addToggle((c) =>
			c.setValue(data.checkOnStartup).onChange(async (v) => {
				data.checkOnStartup = v;
				await plugin.saveSettings();
			}),
		);
		new Setting(containerEl)
			.setName(t("sInterval"))
			.setDesc(t("sIntervalDesc"))
			.addText((c) => {
				c.inputEl.type = "number";
				c.inputEl.min = "0";
				c.setValue(String(data.checkIntervalMin)).onChange(async (v) => {
					const n = Number.parseInt(v, 10);
					data.checkIntervalMin = Number.isFinite(n) && n >= 0 ? n : 0;
					await plugin.saveSettings();
					plugin.scheduleChecks();
				});
			});

		new Setting(containerEl).setName(t("sLocal")).setHeading();
		containerEl.createDiv({ cls: "vps-muted vps-note", text: t("sPatterns") });
		this.patterns(t("sLocalExclude"), t("sLocalExcludeDesc"), data.localExclude, async (v) => {
			data.localExclude = v;
			await plugin.saveSettings();
		});

		new Setting(containerEl).setName(t("sShared")).setHeading().setDesc(t("sSharedDesc"));
		this.patterns(t("sSharedExclude"), "", data.shared.exclude, async (v) => {
			data.shared = { ...data.shared, exclude: v };
			await plugin.saveSettings();
		});
		this.patterns(t("sSecretKeys"), t("sSecretKeysDesc"), data.shared.secretKeys, async (v) => {
			data.shared = { ...data.shared, secretKeys: v };
			await plugin.saveSettings();
		});
		this.patterns(t("sPlainKeys"), t("sPlainKeysDesc"), data.shared.plainKeys, async (v) => {
			data.shared = { ...data.shared, plainKeys: v };
			await plugin.saveSettings();
		});

		new Setting(containerEl).setName(t("sBackups")).setHeading().setDesc(t("sBackupsDesc", { n: KEEP_BACKUPS }));
		const list = containerEl.createDiv({ cls: "vps-backups" });
		void plugin
			.backups()
			.list()
			.then((items) => {
				if (items.length === 0) list.createDiv({ cls: "vps-muted", text: t("sNoBackups") });
				for (const b of items) list.createDiv({ text: `${new Date(b.created).toLocaleString()} - ${b.label}` });
			});
		new Setting(containerEl).addButton((b) => b.setButtonText(t("sUndo")).onClick(() => void plugin.undoLastPull()));
	}

	private patterns(name: string, desc: string, value: string[], save: (v: string[]) => Promise<void>): void {
		new Setting(this.containerEl)
			.setName(name)
			.setDesc(desc)
			.addTextArea((c) => {
				c.inputEl.rows = 4;
				c.inputEl.addClass("vps-patterns");
				c.setValue(value.join("\n")).onChange(async (v) => save(parsePatternList(v)));
			});
	}
}
