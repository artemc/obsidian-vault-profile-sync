import { beforeEach, describe, expect, it } from "vitest";
import { emptySettings } from "../src/core/model";
import { SECRET_MARKER } from "../src/core/secrets";
import { BackupStore } from "../src/engine/backup";
import { Catalog } from "../src/engine/catalog";
import { SyncEngine } from "../src/engine/sync";
import { GitHubClient, RemoteMovedError } from "../src/remote/github";
import { GitHubStore } from "../src/remote/store";
import { browserCache } from "./fakes/httpcache";
import { FakeGitHub } from "./fakes/fakegithub";

import { CFG, Vault } from "./fakes/vault";

const inSync = { incoming: [], outgoing: [], conflicts: [] };

let gh: FakeGitHub;
let a: Vault;

beforeEach(async () => {
	gh = new FakeGitHub();
	gh.release("dataview", "0.5.67");
	gh.release("templater", "2.1.0", "v2.1.0", { "styles.css": ".t{}" });
	gh.release("old-plugin", "1.0.0");
	a = new Vault("A", gh);
	a.installPlugin("dataview", "0.5.67", { refreshInterval: 2500, enableDataviewJs: true });
	a.installPlugin("templater", "2.1.0", { templates_folder: "Templates", openai_api_key: "sk-secret-A" });
	a.installPlugin("old-plugin", "1.0.0", { x: 1 });
	a.fs.put(`${CFG}/hotkeys.json`, JSON.stringify({ "editor:toggle-bold": [{ modifiers: ["Mod"], key: "B" }] }));
	a.fs.put(`${CFG}/appearance.json`, JSON.stringify({ enabledCssSnippets: ["wide"], cssTheme: "" }));
	a.fs.put(`${CFG}/snippets/wide.css`, ".markdown-preview-view { max-width: 100%; }\n");
});

async function freshVault(name: string): Promise<Vault> {
	const v = new Vault(name, gh);
	await v.pull(true);
	return v;
}

describe("first push into an empty repository", () => {
	it("shows everything as outgoing, then everything is in sync", async () => {
		const c = await a.counts();
		expect(c.incoming).toEqual([]);
		expect(c.conflicts).toEqual([]);
		expect(c.outgoing).toEqual(
			expect.arrayContaining(["config:app.json", "config:hotkeys.json", "plugin:dataview", "plugin-data:templater", "snippet:wide", "settings:sync"]),
		);
		expect(c.outgoing).not.toContain("config:workspace.json");
		expect(c.outgoing).not.toContain("config:community-plugins.json");
		expect(c.outgoing.some((k) => k.includes("vault-profile-sync"))).toBe(false);

		await a.push();
		expect(await a.counts()).toEqual(inSync);

		const files = gh.snapshot();
		expect([...files.keys()].sort()).toEqual([
			"config/app.json",
			"config/appearance.json",
			"config/hotkeys.json",
			"plugins/dataview/data.json",
			"plugins/old-plugin/data.json",
			"plugins/templater/data.json",
			"profile.json",
			"snippets/wide.css",
		]);
		const profile = JSON.parse(files.get("profile.json")!);
		expect(profile.plugins.dataview).toEqual({ version: "0.5.67", enabled: true, source: "catalog" });
		expect(files.get("plugins/templater/data.json")).not.toContain("sk-secret-A");
		expect(JSON.parse(files.get("plugins/templater/data.json")!).openai_api_key).toBe(SECRET_MARKER);
	});

	it("works inside a profile folder", async () => {
		const v = new Vault("A2", gh, "profiles/legal");
		v.installPlugin("dataview", "0.5.67");
		await v.push();
		expect([...gh.snapshot().keys()]).toContain("profiles/legal/profile.json");
		expect(await v.counts()).toEqual(inSync);
	});
});

describe("a new vault pulls the whole profile", () => {
	it("reports progress before preparing each change", async () => {
		await a.push();
		const b = new Vault("B", gh);
		const s = await b.status();
		const changes = [...s.result.incoming, ...s.result.conflicts];
		const calls: [number, number, string][] = [];
		await b.engine().pull(s, changes, s.result.settledBase, (done, total, key) => calls.push([done, total, key]));
		expect(calls.map((c) => c[0])).toEqual(changes.map((_, i) => i));
		expect(calls.every((c) => c[1] === changes.length)).toBe(true);
		expect(calls.map((c) => c[2])).toEqual(changes.map((c) => c.key));
	});

	it("installs, enables and configures plugins, and ends in sync", async () => {
		await a.push();
		const b = new Vault("B", gh);
		const before = await b.counts();
		expect(before.incoming).toEqual(expect.arrayContaining(["plugin:dataview", "plugin-data:dataview", "config:hotkeys.json", "snippet:wide"]));
		expect(before.conflicts).toEqual([]);

		const r = await b.pull(true);
		expect(r.failed).toEqual([]);
		expect(b.plugins()).toEqual(["dataview", "old-plugin", "templater"]);
		expect(b.fs.text(`${CFG}/plugins/templater/main.js`)).toBe("// templater 2.1.0\n\n/* nosourcemap */");
		expect(b.fs.text(`${CFG}/plugins/templater/styles.css`)).toBe(".t{}");
		expect(b.fs.json(`${CFG}/community-plugins.json`)).toEqual(["dataview", "old-plugin", "templater"]);
		expect(b.fs.json(`${CFG}/plugins/dataview/data.json`)).toEqual({ enableDataviewJs: true, refreshInterval: 2500 });
		// the secret never reached B; B gets an empty value it can fill in
		expect((b.fs.json(`${CFG}/plugins/templater/data.json`) as Record<string, string>).openai_api_key).toBe("");
		expect(b.fs.text(`${CFG}/workspace.json`)).toBe('{"main": "vault specific"}');
		expect(await b.counts()).toEqual(inSync);
	});

	it("keeps the vault's own secret on pull", async () => {
		await a.push();
		const b = new Vault("B", gh);
		b.installPlugin("templater", "2.1.0", { templates_folder: "Old", openai_api_key: "sk-B" });
		await b.pull(true);
		expect(b.fs.json(`${CFG}/plugins/templater/data.json`)).toEqual({ templates_folder: "Templates", openai_api_key: "sk-B" });
		expect(await b.counts()).toEqual(inSync);
	});

	it("unloads a running plugin before overwriting its settings", async () => {
		await a.push();
		const b = new Vault("B", gh);
		b.installPlugin("dataview", "0.5.67", { refreshInterval: 1 });
		await b.pull(true);
		expect(b.disabled).toContain("dataview");
	});
});

describe("removing a plugin", () => {
	it("propagates the removal and a stale vault cannot bring it back", async () => {
		await a.push();
		const b = await freshVault("B");
		const c = await freshVault("C");
		expect(c.plugins()).toContain("old-plugin");

		// B removes the plugin and pushes
		b.uninstallPlugin("old-plugin");
		expect((await b.counts()).outgoing).toEqual(["plugin-data:old-plugin", "plugin:old-plugin"]);
		await b.push();
		expect(JSON.parse(gh.snapshot().get("profile.json")!).plugins["old-plugin"]).toBeUndefined();
		expect(gh.snapshot().has("plugins/old-plugin/data.json")).toBe(false);

		// C has not pulled yet and changes a hotkey; its push must not restore the plugin
		c.fs.put(`${CFG}/hotkeys.json`, JSON.stringify({ "editor:toggle-italic": [{ modifiers: ["Mod"], key: "I" }] }));
		const cc = await c.counts();
		expect(cc.outgoing).toEqual(["config:hotkeys.json"]);
		expect(cc.incoming).toEqual(["plugin-data:old-plugin", "plugin:old-plugin"]);
		await c.push();
		expect(JSON.parse(gh.snapshot().get("profile.json")!).plugins["old-plugin"]).toBeUndefined();

		// C pulls: the plugin is removed there too
		await c.pull();
		expect(c.plugins()).not.toContain("old-plugin");
		expect(c.fs.json(`${CFG}/community-plugins.json`)).not.toContain("old-plugin");
		expect(await c.counts()).toEqual(inSync);

		// A pulls both changes
		await a.pull();
		expect(a.plugins()).toEqual(["dataview", "templater"]);
		expect(a.fs.json(`${CFG}/hotkeys.json`)).toEqual({ "editor:toggle-italic": [{ key: "I", modifiers: ["Mod"] }] });
		expect(await a.counts()).toEqual(inSync);
	});

	it("disabling a plugin travels as a change of its entry", async () => {
		await a.push();
		const b = await freshVault("B");
		a.fs.put(`${CFG}/community-plugins.json`, JSON.stringify(["dataview", "templater"]));
		expect((await a.counts()).outgoing).toEqual(["plugin:old-plugin"]);
		await a.push();
		await b.pull();
		expect(b.fs.json(`${CFG}/community-plugins.json`)).toEqual(["dataview", "templater"]);
		expect(b.plugins()).toContain("old-plugin");
	});
});

describe("conflicts and concurrency", () => {
	it("reports a conflict when both vaults change the same settings", async () => {
		await a.push();
		const b = await freshVault("B");
		a.fs.put(`${CFG}/plugins/dataview/data.json`, JSON.stringify({ refreshInterval: 1000 }));
		b.fs.put(`${CFG}/plugins/dataview/data.json`, JSON.stringify({ refreshInterval: 9000 }));
		await a.push();
		const cb = await b.counts();
		expect(cb.conflicts).toEqual(["plugin-data:dataview"]);
		// B keeps its own version: pushing the conflict overwrites the profile
		await b.push();
		expect(JSON.parse(gh.snapshot().get("plugins/dataview/data.json")!)).toEqual({ refreshInterval: 9000 });
		expect((await a.counts()).incoming).toEqual(["plugin-data:dataview"]);
	});

	it("refuses to push over a profile that moved since the comparison", async () => {
		await a.push();
		const b = await freshVault("B");
		a.fs.put(`${CFG}/app.json`, JSON.stringify({ spellcheck: true }));
		const stale = await a.status();
		b.fs.put(`${CFG}/hotkeys.json`, "{}");
		await b.push();
		await expect(a.engine().push(stale, stale.result.outgoing, stale.result.settledBase)).rejects.toBeInstanceOf(RemoteMovedError);
		// comparing again shows both sides, and the push then succeeds
		expect(await a.counts()).toEqual({ incoming: ["config:hotkeys.json"], outgoing: ["config:app.json"], conflicts: [] });
		await a.push();
		expect(JSON.parse(gh.snapshot().get("config/app.json")!)).toEqual({ spellcheck: true });
	});

	it("does not report a different key order as a change", async () => {
		a.fs.put(`${CFG}/app.json`, '{"b": 1, "a": 2}');
		await a.push();
		a.fs.put(`${CFG}/app.json`, '{"a": 2,\n "b": 1}');
		expect(await a.counts()).toEqual(inSync);
	});
});

describe("exclusions", () => {
	it("a vault-only plugin is neither pushed nor removed", async () => {
		await a.push();
		const b = await freshVault("B");
		b.installPlugin("local-thing", "1.0.0", { y: 1 });
		b.localExclude = ["local-thing"];
		expect(await b.counts()).toEqual(inSync);
		await b.pull();
		expect(b.plugins()).toContain("local-thing");
	});

	it("shared exclusions travel with the profile", async () => {
		a.shared = { exclude: ["config:graph.json"], secretKeys: ["templates_folder"], plainKeys: [] };
		a.fs.put(`${CFG}/graph.json`, "{}");
		await a.push();
		expect(gh.snapshot().has("config/graph.json")).toBe(false);
		expect(JSON.parse(gh.snapshot().get("plugins/templater/data.json")!).templates_folder).toBe(SECRET_MARKER);
		const b = await freshVault("B");
		expect(b.shared).toEqual({ exclude: ["config:graph.json"], secretKeys: ["templates_folder"], plainKeys: [] });
	});
});

describe("regressions", () => {
	it("an HTTP cache in front of GitHub does not hide the latest commit", async () => {
		// Obsidian's requestUrl keeps GET responses for GitHub's max-age=60. A stale
		// branch head after a push makes every pushed item look removed in the profile.
		a.http = browserCache(gh.http);
		expect((await a.counts()).outgoing.length).toBeGreaterThan(0);
		await a.push();
		expect(await a.counts()).toEqual(inSync);

		const b = new Vault("B", gh);
		b.http = browserCache(gh.http);
		expect((await b.counts()).incoming).toContain("plugin:dataview");
		await b.pull(true);
		a.fs.put(`${CFG}/snippets/wide.css`, ".x {}\n");
		await a.push();
		expect((await b.counts()).incoming).toEqual(["snippet:wide"]);
	});

	it("a secret recognised by its value does not come back as an outgoing change", async () => {
		// The key name is harmless, the value is a URL with a password.
		a.installPlugin("proxy", "1.0.0", { socks: "socks5://me:pw@host", other: 1 });
		gh.release("proxy", "1.0.0");
		await a.push();
		const b = await freshVault("B");
		expect(await b.counts()).toEqual(inSync);
		const c = new Vault("C", gh);
		c.installPlugin("proxy", "1.0.0", { socks: "socks5://localhost:1080", other: 2 });
		await c.pull(true);
		expect(await c.counts()).toEqual(inSync);
		// Nothing B or C could push now would overwrite A's password with an empty value.
		a.fs.put(`${CFG}/plugins/proxy/data.json`, JSON.stringify({ socks: "socks5://me:pw@host", other: 3 }));
		await a.push();
		await b.pull();
		expect(a.fs.json(`${CFG}/plugins/proxy/data.json`)).toMatchObject({ socks: "socks5://me:pw@host" });
		expect(await b.counts()).toEqual(inSync);
	});

	it("a not-secret key is synced only once both the vault and the profile list it", async () => {
		a.installPlugin("proxy", "1.0.0", { pluginTokens: "persist:surfing", socks: "socks5://me:pw@host" });
		gh.release("proxy", "1.0.0");
		await a.push();
		const b = await freshVault("B");
		expect(gh.snapshot().get("plugins/proxy/data.json")).not.toContain("persist:surfing");

		a.shared = { ...a.shared, plainKeys: ["pluginTokens"] };
		// The profile does not list the key yet, so the value still stays home.
		expect((await a.counts()).outgoing).toEqual(["settings:sync"]);
		await a.push();
		expect((await a.counts()).outgoing).toEqual(["plugin-data:proxy"]);
		await a.push();
		const pushed = gh.snapshot().get("plugins/proxy/data.json")!;
		expect(pushed).toContain("persist:surfing");
		expect(pushed).not.toContain("me:pw");

		// B has not pulled the new settings: it sees incoming changes, not conflicts.
		expect(await b.counts()).toEqual({ incoming: ["plugin-data:proxy", "settings:sync"], outgoing: [], conflicts: [] });
		await b.pull();
		expect(b.fs.json(`${CFG}/plugins/proxy/data.json`)).toMatchObject({ pluginTokens: "persist:surfing" });
		expect(await b.counts()).toEqual(inSync);
	});

	it("a vault that has not pulled a new secret key does not push that secret", async () => {
		await a.push();
		const b = await freshVault("B");
		b.fs.put(`${CFG}/plugins/dataview/data.json`, JSON.stringify({ refreshInterval: 2500, enableDataviewJs: true, licenseCode: "B-PRIVATE" }));
		a.shared = { exclude: [], secretKeys: ["licenseCode"], plainKeys: [] };
		await a.push();
		// B pushes its plugin settings without having pulled the new shared settings
		await b.push((c) => c.key === "plugin-data:dataview");
		expect(gh.snapshot().get("plugins/dataview/data.json")).not.toContain("B-PRIVATE");
		expect(b.shared.secretKeys).toEqual([]);
	});

	it("shared exclusions apply before the vault has pulled them", async () => {
		a.shared = { exclude: ["config:graph.json"], secretKeys: [], plainKeys: [] };
		await a.push();
		const b = new Vault("B", gh);
		b.fs.put(`${CFG}/graph.json`, '{"scale": 2}');
		expect((await b.counts()).outgoing).not.toContain("config:graph.json");
	});

	it("never installs or removes itself from the profile", async () => {
		await gh.commitFiles({
			"profile.json": JSON.stringify({ schema: 1, plugins: { "vault-profile-sync": { version: "9.9.9", enabled: true, source: "vendor" } } }),
			"vendor/plugins/vault-profile-sync/main.js": "evil",
			"vendor/plugins/vault-profile-sync/manifest.json": '{"id":"vault-profile-sync","version":"9.9.9"}',
		});
		const b = new Vault("B", gh);
		const c = await b.counts();
		expect([...c.incoming, ...c.conflicts, ...c.outgoing].some((k) => k.startsWith("plugin:vault-profile-sync"))).toBe(false);
		await b.pull(true);
		expect(b.fs.text(`${CFG}/plugins/vault-profile-sync/manifest.json`)).toContain("0.1.0");
	});

	it("creates the branch in a repository that has other branches", async () => {
		await gh.commitFiles({ "README.md": "hello" });
		const v = new Vault("A3", gh);
		v.installPlugin("dataview", "0.5.67");
		const engine = () =>
			new SyncEngine(
				{
					fs: v.fs,
					http: gh.http,
					host: { isPluginLoaded: () => false, disablePlugin: async () => {} },
					store: new GitHubStore(new GitHubClient(gh.http, gh.owner, gh.repo, "tok"), "profiles", ""),
					catalog: new Catalog(gh.http),
				},
				{ configDir: CFG, selfId: "vault-profile-sync", vaultName: "A3", localExclude: [], shared: emptySettings() },
			);
		const s = await engine().compare({});
		const r = await engine().push(s, s.result.outgoing, s.result.settledBase);
		expect(gh.head("profiles")).toBe(r.commit);
		expect(gh.snapshot("profiles").has("README.md")).toBe(false);
		expect(gh.snapshot("main").has("profile.json")).toBe(false);
		const again = await engine().compare(r.base);
		expect(again.result.outgoing).toEqual([]);
	});
});

describe("plugins outside the catalog", () => {
	it("are stored in vendor/ and installed from there", async () => {
		a.installPlugin("my-private", "0.3.0", { z: 1 });
		a.fs.put(`${CFG}/plugins/my-private/styles.css`, ".p{}");
		await a.push();
		const files = gh.snapshot();
		expect(files.get("vendor/plugins/my-private/main.js")).toBe("// my-private 0.3.0\n\n/* nosourcemap */");
		expect(JSON.parse(files.get("profile.json")!).plugins["my-private"].source).toBe("vendor");
		const b = await freshVault("B");
		expect(b.fs.text(`${CFG}/plugins/my-private/styles.css`)).toBe(".p{}");
		expect(await b.counts()).toEqual(inSync);
		// removal deletes the vendored copy too
		a.uninstallPlugin("my-private");
		await a.push();
		expect([...gh.snapshot().keys()].some((p) => p.startsWith("vendor/"))).toBe(false);
	});
});

describe("themes", () => {
	it("installs a catalog theme by name and removes it with the profile", async () => {
		gh.themes.push({ name: "Minimal", repo: "kepano/obsidian-minimal" });
		gh.downloads.set("https://raw.githubusercontent.com/kepano/obsidian-minimal/HEAD/theme.css", new TextEncoder().encode("body{}"));
		gh.downloads.set(
			"https://raw.githubusercontent.com/kepano/obsidian-minimal/HEAD/manifest.json",
			new TextEncoder().encode('{"name":"Minimal","version":"7.7.0"}'),
		);
		a.fs.put(`${CFG}/themes/Minimal/manifest.json`, '{"name":"Minimal","version":"7.7.0"}');
		a.fs.put(`${CFG}/themes/Minimal/theme.css`, "body{}");
		await a.push();
		expect(JSON.parse(gh.snapshot().get("profile.json")!).themes).toEqual({ Minimal: { version: "7.7.0", source: "catalog" } });
		const b = await freshVault("B");
		expect(b.fs.text(`${CFG}/themes/Minimal/theme.css`)).toBe("body{}");
		expect(await b.counts()).toEqual(inSync);
		void a.fs.rmdir(`${CFG}/themes/Minimal`, true);
		await a.push();
		await b.pull();
		expect(await b.fs.exists(`${CFG}/themes/Minimal`)).toBe(false);
	});
});

describe("updates and undo", () => {
	it("updates a plugin to the profile's version", async () => {
		await a.push();
		const b = await freshVault("B");
		gh.release("dataview", "0.5.68");
		a.installPlugin("dataview", "0.5.68", { refreshInterval: 2500, enableDataviewJs: true });
		await a.push();
		expect((await b.counts()).incoming).toEqual(["plugin:dataview"]);
		await b.pull();
		expect(b.fs.text(`${CFG}/plugins/dataview/main.js`)).toBe("// dataview 0.5.68\n\n/* nosourcemap */");
		expect(b.fs.json(`${CFG}/plugins/dataview/data.json`)).toEqual({ enableDataviewJs: true, refreshInterval: 2500 });
	});

	it("reports a missing release and applies the rest", async () => {
		await a.push();
		gh.downloads.clear();
		const b = new Vault("B", gh);
		const r = await b.pull(true);
		expect(r.failed.map((f) => f.key).sort()).toEqual(["plugin:dataview", "plugin:old-plugin", "plugin:templater"]);
		expect(b.fs.text(`${CFG}/snippets/wide.css`)).toBeDefined();
		expect((await b.counts()).incoming).toEqual(["plugin:dataview", "plugin:old-plugin", "plugin:templater"]);
	});

	it("undoes the last pull", async () => {
		await a.push();
		const b = new Vault("B", gh);
		b.fs.put(`${CFG}/app.json`, '{"mine": true}');
		// the backup keeps the base the pull started from: only items both sides already agreed on
		const baseBefore = (await b.status()).result.settledBase;
		expect(Object.keys(baseBefore)).toEqual(["settings:sync"]);
		const r = await b.pull(true);
		expect(r.backupDir).toBeTruthy();
		const store = new BackupStore(b.fs, `${CFG}/plugins/vault-profile-sync/backups`);
		expect(await store.list()).toHaveLength(1);
		const restoredBase = await store.restoreLatest();
		expect(restoredBase).toEqual(baseBefore);
		expect(b.fs.text(`${CFG}/app.json`)).toBe('{"mine": true}');
		expect(b.plugins()).toEqual([]);
		expect(b.fs.json(`${CFG}/community-plugins.json`)).toEqual([]);
		expect(b.fs.text(`${CFG}/snippets/wide.css`)).toBeUndefined();
		expect(await store.list()).toHaveLength(0);
	});
});
