import { describe, expect, it } from "vitest";
import { canonicalJson, gitBlobSha } from "../src/core/canonical";
import { classify, classifyOne } from "../src/core/classify";
import { itemDiff, jsonDiff } from "../src/core/diff";
import { ExcludeRules, parsePatternList } from "../src/core/exclude";
import { fileItem, parseProfile, repoPathToItem, itemRepoPath, type Snapshot } from "../src/core/model";
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
		for (const k of ["token", "githubToken", "api_key", "openAIApiKey", "password", "client-secret", "accessKey", "myField"]) {
			expect(m.isSecretKey(k), k).toBe(true);
		}
		for (const k of ["author", "maxTokens", "tokenLimit", "secretary", "keyboard", "path"]) expect(m.isSecretKey(k), k).toBe(false);
	});

	it("redacts strings at any depth and restores local values", () => {
		const data = { apiKey: "sk-1", nested: { list: [{ token: "t" }], name: "n" }, showPassword: true };
		const red = redactSecrets(data, m);
		expect(red).toEqual({ apiKey: SECRET_MARKER, nested: { list: [{ token: SECRET_MARKER }], name: "n" }, showPassword: true });
		expect(restoreSecrets(red, { apiKey: "mine", nested: { list: [{ token: "t2" }] } })).toEqual({
			apiKey: "mine",
			nested: { list: [{ token: "t2" }], name: "n" },
			showPassword: true,
		});
		expect(restoreSecrets(red, undefined)).toMatchObject({ apiKey: "" });
	});

	it("keeps a restored empty secret in sync", () => {
		const restored = restoreSecrets({ apiKey: SECRET_MARKER }, undefined);
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
