import { describe, expect, it } from "vitest";
import { canonicalJson, gitBlobSha, type Json } from "../src/core/canonical";
import { classify, classifyOne } from "../src/core/classify";
import { itemDiff, jsonDiff } from "../src/core/diff";
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
			{ path: "b.c", type: "changed", before: "2", after: "3" },
			{ path: "d", type: "added", after: "true" },
		]);
	});
	it("diffs CSS by line", () => {
		const d = itemDiff(".a { color: red; }\n", ".a { color: blue; }\n");
		expect(d.kind).toBe("text");
		expect(d.rows.map((r) => r.type)).toEqual(["removed", "added"]);
	});
});

describe("install like Obsidian", () => {
	it("drops source maps and appends the nosourcemap marker once", () => {
		expect(asInstalledByObsidian("a();\n")).toBe("a();\n\n/* nosourcemap */");
		expect(asInstalledByObsidian("a();\n//# sourceMappingURL=data:application/json;base64,AAA=\n")).toBe("a();\n\n\n/* nosourcemap */");
		expect(asInstalledByObsidian("a();\n\n/* nosourcemap */")).toBe("a();\n\n/* nosourcemap */");
	});
});
