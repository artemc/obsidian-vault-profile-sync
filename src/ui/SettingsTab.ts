/** Plugin settings: connection, update checks, exclusions, backups. */

import { PluginSettingTab, Setting, type App } from "obsidian";
import { parsePatternList } from "../core/exclude";
import { sameStore, storeLabel } from "../core/stores";
import type { FolderStore } from "../remote/folder";
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
		const saved = plugin.savedStores().filter((x) => !sameStore(x, data));
		if (saved.length > 0) {
			new Setting(containerEl)
				.setName(t("sSaved"))
				.setDesc(t("sSavedDesc"))
				.addDropdown((c) => {
					c.addOption("", t("sSavedPick"));
					saved.forEach((x, i) => c.addOption(String(i), storeLabel(x)));
					c.onChange(async (v) => {
						if (v === "") return;
						plugin.useStore(saved[Number(v)]);
						await plugin.saveSettings();
						plugin.setStatusText();
						this.display();
					});
				})
				.addExtraButton((b) =>
					b
						.setIcon("list-x")
						.setTooltip(t("sSavedClear"))
						.onClick(() => {
							for (const x of saved) plugin.forgetStore(x);
							this.display();
						}),
				);
		}
		new Setting(containerEl).setName(t("sKind")).addDropdown((c) =>
			c
				.addOption("github", "GitHub")
				.addOption("folder", t("sKindFolder"))
				.setValue(data.kind)
				.onChange(async (v) => {
					data.kind = v === "folder" ? "folder" : "github";
					await plugin.saveSettings();
					plugin.setStatusText();
					this.display();
				}),
		);
		if (data.kind === "folder") {
			new Setting(containerEl)
				.setName(t("sPath"))
				.setDesc(t("sPathDesc"))
				.addText((c) =>
					c
						.setPlaceholder("/Users/me/Dropbox/obsidian-settings")
						.setValue(data.path)
						.onChange(async (v) => {
							data.path = v.trim();
							await plugin.saveSettings();
							plugin.setStatusText();
							noteLocation();
						}),
				);
		}
		const github = containerEl.createDiv();
		if (data.kind === "folder") github.hide();
		new Setting(github)
			.setName(t("sRepo"))
			.setDesc(t("sRepoDesc"))
			.addText((c) =>
				c
					.setPlaceholder("owner/obsidian-settings")
					.setValue(data.repo)
					.onChange(async (v) => {
						data.repo = v.trim();
						await plugin.saveSettings();
						noteLocation();
					}),
			);
		new Setting(github).setName(t("sBranch")).addText((c) =>
			c
				.setPlaceholder("main")
				.setValue(data.branch)
				.onChange(async (v) => {
					data.branch = v.trim() || "main";
					await plugin.saveSettings();
					noteLocation();
				}),
		);
		new Setting(github)
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

		const tokenSetting = new Setting(github).setName(t("sToken")).setDesc(t(plugin.tokens().shared() ? "sTokenDescShared" : "sTokenDescVault"));
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
					if (data.kind === "folder") {
						const store = plugin.store() as FolderStore;
						await store.check();
						const { files } = await store.list();
						testResult.setText(files.size > 0 ? t("sTestFolderOk", { n: files.size }) : t("sTestFolderEmpty"));
						testResult.className = "vps-note vps-ok";
						return;
					}
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
