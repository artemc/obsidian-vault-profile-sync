import { describe, expect, it } from "vitest";
import { canonicalJson, gitBlobSha, type Json } from "../src/core/canonical";
import { classify, classifyOne, defaultDirection, sideStates, type Change } from "../src/core/classify";
import { buildTree, corePluginIds, groupOf } from "../src/core/groups";
import { mergedChange, mergeJson, prepareMerge, rowId } from "../src/core/merge";
import { itemDiff, jsonDiff, sideBySide } from "../src/core/diff";
import { ExcludeRules, parsePatternList } from "../src/core/exclude";
import { emptySettings, fileItem, parseProfile, repoPathToItem, itemRepoPath, settingsText, type Snapshot } from "../src/core/model";
import { asInstalledByObsidian } from "../src/engine/catalog";
import { redactSecrets, restoreSecrets, SECRET_MARKER, SecretMatcher } from "../src/core/secrets";

describe("canonical", () => {
	it("computes real git blob ids", async () => {
		// git hash-object of "hello\n"
		expect(await gitBlobSha("hello\n")).toBe("ce013625030ba8dba906f756967f9e9ca394464a");
		expect(await gitBlobSha("")).toBe("e69de29bb2d1d6434b8b29ae775ad8c2e48c5391");
	});

	it("ignores key order", () => {
		expect(canonicalJson({ b: 1, a: { d: [3, { y: 1, x: 2 }], c: 2 } })).toBe(canonicalJson({ a: { c: 2, d: [3, { x: 2, y: 1 }] }, b: 1 }));
		expect(canonicalJson({ a: 1 })).toBe('{\n  "a": 1\n}\n');
	});
});

describe("classify", () => {
	it("follows the three-way table", () => {
		expect(classifyOne("a", "a", null)).toBe("same");
		expect(classifyOne("a", "b", "a")).toBe("incoming");
		expect(classifyOne("b", "a", "a")).toBe("outgoing");
		expect(classifyOne("b", "c", "a")).toBe("conflict");
		// removals and additions are ordinary changes against the base
		expect(classifyOne("a", null, "a")).toBe("incoming");
		expect(classifyOne(null, "a", "a")).toBe("outgoing");
		expect(classifyOne(null, "a", null)).toBe("incoming");
		expect(classifyOne("a", null, null)).toBe("outgoing");
		expect(classifyOne(null, null, "a")).toBe("same");
		// changed here, removed there
		expect(classifyOne("b", null, "a")).toBe("conflict");
	});

	it("treats an empty profile as all outgoing, never as in sync", async () => {
		const local: Snapshot = new Map([["config:app.json", await fileItem("config", "app.json", "{}\n")]]);
		const r = classify(local, new Map(), {});
		expect(r.outgoing.map((c) => c.key)).toEqual(["config:app.json"]);
		expect(r.same).toEqual([]);
	});

	it("settles the base for items both sides agree on and drops vanished ones", async () => {
		const item = await fileItem("config", "app.json", "{}\n");
		const r = classify(new Map([[item.key, item]]), new Map([[item.key, item]]), { [item.key]: "old", "config:gone.json": "x" });
		expect(r.settledBase).toEqual({ [item.key]: item.hash });
	});
});

describe("secrets", () => {
	const m = new SecretMatcher(["myField"]);
	it("matches credential-like key names only", () => {
		for (const k of ["token", "githubToken", "api_key", "openAIApiKey", "password", "client-secret", "accessKey", "myField", "pluginTokens", "apiKeys", "passwords", "credentials"]) {
			expect(m.isSecretKey(k), k).toBe(true);
		}
		for (const k of ["author", "tokenLimit", "secretary", "keyboard", "path", "geminiApiKeyName"]) expect(m.isSecretKey(k), k).toBe(false);
		// a plural name matches; only string values are redacted, so numeric limits survive
		expect(m.isSecretKey("maxTokens")).toBe(true);
		expect(redactSecrets({ maxTokens: 4096 }, m)).toEqual({ maxTokens: 4096 });
	});

	it("restored values scan back to the profile's text", () => {
		const profile = { proxy: "socks5://a:pw@host", list: ["ghp_" + "x".repeat(36)], token: "t" };
		const red = redactSecrets(profile, m);
		const locals: (Json | undefined)[] = [undefined, { proxy: "socks5://localhost:1080", list: [""], token: "" }, { proxy: "socks5://b:pw2@h", list: ["ghp_" + "y".repeat(36)] }];
		for (const local of locals) {
			const restored = restoreSecrets(red, local, m);
			expect(redactSecrets(restored, m), JSON.stringify(local)).toEqual(red);
		}
		// a local credential stays; a harmless local value cannot stand in for one
		expect(restoreSecrets(red, { proxy: "socks5://b:pw2@h" }, m)).toMatchObject({ proxy: "socks5://b:pw2@h", token: "" });
		expect(restoreSecrets(red, { proxy: "socks5://localhost:1080" }, m)).toMatchObject({ proxy: SECRET_MARKER });
	});

	it("plain keys turn off the name rule but not the value rule", () => {
		const p = new SecretMatcher(["myField"], ["plugin_tokens", "myField"]);
		expect(p.isSecretKey("pluginTokens")).toBe(false);
		expect(p.isSecretKey("token")).toBe(true);
		expect(p.isSecretKey("myField")).toBe(true); // an explicit secret key wins
		expect(redactSecrets({ pluginTokens: "persist:surfing-vault-${appId}" }, p)).toEqual({ pluginTokens: "persist:surfing-vault-${appId}" });
		expect(redactSecrets({ pluginTokens: "socks5://u:pw@host" }, p)).toEqual({ pluginTokens: SECRET_MARKER });
	});

	it("settings without plain keys keep the hash they had before plain keys existed", () => {
		expect(settingsText(emptySettings())).toBe(canonicalJson({ exclude: [], secretKeys: [] }));
		expect(JSON.parse(settingsText({ ...emptySettings(), plainKeys: ["x"] })).plainKeys).toEqual(["x"]);
	});

	it("redacts strings at any depth and restores local values", () => {
		const data = { apiKey: "sk-1", nested: { list: [{ token: "t" }], name: "n" }, showPassword: true };
		const red = redactSecrets(data, m);
		expect(red).toEqual({ apiKey: SECRET_MARKER, nested: { list: [{ token: SECRET_MARKER }], name: "n" }, showPassword: true });
		expect(restoreSecrets(red, { apiKey: "mine", nested: { list: [{ token: "t2" }] } }, m)).toEqual({
			apiKey: "mine",
			nested: { list: [{ token: "t2" }], name: "n" },
			showPassword: true,
		});
		expect(restoreSecrets(red, undefined, m)).toMatchObject({ apiKey: "" });
	});

	it("redacts credentials by value shape whatever the key is", () => {
		const data = {
			socksProxy: "socks5://user:p4ss@10.0.0.1:1080",
			plainProxy: "socks5://10.0.0.1:1080",
			note: "github_pat_11ABCDEFG0123456789_abcdefghijklmnop",
			list: ["sk-abcdefghijklmnopqrstuvwx", "plain"],
			template: "a:b-c-${ver}",
		};
		expect(redactSecrets(data, m)).toEqual({
			socksProxy: SECRET_MARKER,
			plainProxy: "socks5://10.0.0.1:1080",
			note: SECRET_MARKER,
			list: [SECRET_MARKER, "plain"],
			template: "a:b-c-${ver}",
		});
	});

	it("keeps a restored empty secret in sync", () => {
		const restored = restoreSecrets({ apiKey: SECRET_MARKER }, undefined, m);
		expect(redactSecrets(restored, m)).toEqual({ apiKey: SECRET_MARKER });
	});
});

describe("exclude", () => {
	const r = new ExcludeRules(parsePatternList("# comment\nobsidian-git\nconfig:graph.json\nplugin-data:big-*\n"));
	it("applies built-in, key, name and wildcard rules", () => {
		expect(r.isExcluded("config:workspace.json")).toBe(true);
		expect(r.isExcluded("config:graph.json")).toBe(true);
		expect(r.isExcluded("plugin:obsidian-git")).toBe(true);
		expect(r.isExcluded("plugin-data:obsidian-git")).toBe(true);
		expect(r.isExcluded("plugin-data:big-cache")).toBe(true);
		expect(r.isExcluded("plugin:big-cache")).toBe(false);
		expect(r.isExcluded("config:app.json")).toBe(false);
		expect(r.isExcluded("settings:sync")).toBe(false);
	});
	it("excluding a plugin excludes its settings", () => {
		expect(new ExcludeRules(["plugin:dataview"]).isExcluded("plugin-data:dataview")).toBe(true);
	});
});

describe("model", () => {
	it("maps repository paths both ways", () => {
		for (const [kind, name] of [
			["config", "app.json"],
			["plugin-data", "dataview"],
			["snippet", "wide tables"],
		] as const) {
			expect(repoPathToItem(itemRepoPath(kind, name)!)).toEqual({ kind, name });
		}
		expect(repoPathToItem("vendor/plugins/x/main.js")).toBeNull();
		expect(repoPathToItem("profile.json")).toBeNull();
	});

	it("refuses a newer profile schema", () => {
		expect(() => parseProfile('{"schema": 99}')).toThrow(/newer/);
		expect(parseProfile('{"schema":1,"plugins":{"a":{"version":"1.0.0"}}}').plugins.a).toEqual({ version: "1.0.0", enabled: true, source: "catalog" });
	});
});

describe("diff", () => {
	it("diffs JSON by key path", () => {
		expect(jsonDiff({ a: 1, b: { c: 2 } }, { a: 1, b: { c: 3 }, d: true })).toEqual([
			{ path: "b.c", segments: ["b", "c"], type: "changed", before: "2", after: "3" },
			{ path: "d", segments: ["d"], type: "added", after: "true" },
		]);
	});
	it("diffs CSS by line", () => {
		const d = itemDiff(".a { color: red; }\n", ".a { color: blue; }\n");
		expect(d.kind).toBe("text");
		expect(d.rows.map((r) => r.type)).toEqual(["removed", "added"]);
	});
	it("lines up two whole texts side by side", () => {
		expect(sideBySide("a\nb\nc\n", "a\nB\nB2\nc\n")).toEqual([
			{ left: "a", right: "a", changed: false },
			{ left: "b", right: "B", changed: true },
			{ left: undefined, right: "B2", changed: true },
			{ left: "c", right: "c", changed: false },
		]);
		expect(sideBySide("", "x\n")).toEqual([{ left: undefined, right: "x", changed: true }]);
		expect(sideBySide("same\n", "same\n")).toEqual([{ left: "same", right: "same", changed: false }]);
	});
});

describe("install like Obsidian", () => {
	it("drops source maps and appends the nosourcemap marker once", () => {
		expect(asInstalledByObsidian("a();\n")).toBe("a();\n\n/* nosourcemap */");
		expect(asInstalledByObsidian("a();\n//# sourceMappingURL=data:application/json;base64,AAA=\n")).toBe("a();\n\n\n/* nosourcemap */");
		expect(asInstalledByObsidian("a();\n\n/* nosourcemap */")).toBe("a();\n\n/* nosourcemap */");
	});
});

describe("two-panel view", () => {
	const item = (hash: string | null) => (hash === null ? null : { key: "config:x.json", kind: "config" as const, name: "x.json", hash });
	const change = (l: string | null, r: string | null, b: string | null): Change => ({
		key: "config:x.json",
		status: classifyOne(l, r, b),
		local: item(l),
		remote: item(r),
		base: b,
	});

	it("tells how each side differs from the base", () => {
		expect(sideStates(change("1", "1", "1"))).toEqual({ local: "same", remote: "same" });
		expect(sideStates(change("2", "1", "1"))).toEqual({ local: "edited", remote: "same" });
		expect(sideStates(change("1", "2", "1"))).toEqual({ local: "same", remote: "edited" });
		expect(sideStates(change("2", "3", "1"))).toEqual({ local: "edited", remote: "edited" });
		expect(sideStates(change(null, "1", null))).toEqual({ local: "absent", remote: "added" });
		expect(sideStates(change("1", null, null))).toEqual({ local: "added", remote: "absent" });
		expect(sideStates(change(null, "1", "1"))).toEqual({ local: "removed", remote: "same" });
		expect(sideStates(change("2", null, "1"))).toEqual({ local: "edited", remote: "removed" });
		// never synced: which one is newer is unknown
		expect(sideStates(change("1", "2", null))).toEqual({ local: "edited", remote: "edited" });
	});

	it("proposes the direction of the status", () => {
		expect(defaultDirection(change("1", "2", "1"))).toBe("pull");
		expect(defaultDirection(change("2", "1", "1"))).toBe("push");
		expect(defaultDirection(change("2", "3", "1"))).toBe("skip");
	});

	it("groups Obsidian settings, core plugins, community plugins and unknown files", () => {
		const core = corePluginIds('{"switcher": true, "my-new-core": false}');
		expect(groupOf("config:app.json", core)).toBe("obsidian");
		expect(groupOf("config:types.json", core)).toBe("obsidian");
		expect(groupOf("config:switcher.json", core)).toBe("core");
		expect(groupOf("config:my-new-core.json", core)).toBe("core");
		expect(groupOf("config:canvas.json", corePluginIds()), "known without core-plugins.json").toBe("core");
		expect(groupOf("config:community-plugins-settings.json", core)).toBe("other");
		expect(groupOf("plugin-data:dataview", core)).toBe("community");
		expect(groupOf("settings:sync", core)).toBe("sync");
	});

	it("nests plugin settings under the plugin and keeps excluded items in place", () => {
		const c = (key: string): Change => ({ key, status: "same", local: null, remote: null, base: null });
		const tree = buildTree([c("plugin:dataview"), c("plugin-data:dataview"), c("config:app.json"), c("config:vault-setup.json")], ["plugin:local-only"], corePluginIds());
		expect(tree.map((g) => g.id)).toEqual(["obsidian", "community", "other"]);
		const community = tree.find((g) => g.id === "community")!;
		expect(community.rows.map((r) => [r.key, r.change === null, r.children.map((x) => x.key)])).toEqual([
			["plugin:dataview", false, ["plugin-data:dataview"]],
			["plugin:local-only", true, []],
		]);
	});

	it("merges key by key, with dots in key names and removed keys", async () => {
		const local = canonicalJson({ menus: { "dom:div.a": { order: [1] }, keep: 1 }, onlyLocal: true, x: 1 });
		const remote = canonicalJson({ menus: { "dom:div.a": { order: [2] }, keep: 1 }, onlyRemote: "r", x: 2 });
		const m = prepareMerge(local, remote)!;
		expect(m.rows.map((r) => r.segments)).toEqual([["menus", "dom:div.a", "order"], ["onlyLocal"], ["onlyRemote"], ["x"]]);
		const pick = (paths: string[][]) => new Map(m.rows.filter((r) => paths.some((p) => JSON.stringify(p) === rowId(r))).map((r) => [rowId(r), "remote" as const]));

		expect(mergeJson(m, new Map())).toBe(local);
		const merged = JSON.parse(mergeJson(m, pick([["menus", "dom:div.a", "order"], ["onlyLocal"], ["onlyRemote"]])));
		expect(merged).toEqual({ menus: { "dom:div.a": { order: [2] }, keep: 1 }, onlyRemote: "r", x: 1 });

		const all = await mergedChange({ key: "config:x.json", status: "conflict", local: null, remote: null, base: "b" }, m, pick(m.rows.map((r) => r.segments)));
		expect(all.change.local!.text).toBe(remote);
		expect([all.pull, all.push]).toEqual([true, false]);
		const mine = await mergedChange({ key: "config:x.json", status: "conflict", local: null, remote: null, base: "b" }, m, new Map());
		expect([mine.pull, mine.push]).toEqual([false, true]);
		expect(prepareMerge(".a{}", remote)).toBeNull();
	});
});
