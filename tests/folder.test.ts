import { mkdtemp, readFile, readdir, rm, writeFile, mkdir } from "node:fs/promises";
import * as fsp from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FolderStore, type DiskFs } from "../src/remote/folder";
import { RemoteMovedError } from "../src/remote/github";
import { FakeGitHub } from "./fakes/fakegithub";
import { CFG, Vault } from "./fakes/vault";

const inSync = { incoming: [], outgoing: [], conflicts: [] };
let root: string;
let gh: FakeGitHub;

const store = () => new FolderStore(fsp as unknown as DiskFs, root);
const vault = (name: string) => new Vault(name, gh, "", store);

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "vps-folder-"));
	gh = new FakeGitHub();
	gh.release("dataview", "0.5.67");
});

afterEach(async () => {
	await rm(root, { recursive: true, force: true });
});

describe("profile in a folder", () => {
	it("pushes into an empty folder, a new vault pulls it, both end in sync", async () => {
		const a = vault("A");
		a.installPlugin("dataview", "0.5.67", { refreshInterval: 2500, apiKey: "sk-secret" });
		a.fs.put(`${CFG}/hotkeys.json`, JSON.stringify({ x: [] }));
		await a.push();
		expect(await a.counts()).toEqual(inSync);
		const profile = JSON.parse(await readFile(join(root, "profile.json"), "utf8"));
		expect(profile.plugins.dataview.version).toBe("0.5.67");
		expect(await readFile(join(root, "plugins/dataview/data.json"), "utf8")).not.toContain("sk-secret");

		const b = vault("B");
		await b.pull(true);
		expect(b.plugins()).toEqual(["dataview"]);
		expect(b.fs.json(`${CFG}/hotkeys.json`)).toEqual({ x: [] });
		expect(await b.counts()).toEqual(inSync);
	});

	it("refuses to write over a folder that changed since the comparison", async () => {
		const a = vault("A");
		a.fs.put(`${CFG}/hotkeys.json`, "{}");
		await a.push();
		const stale = await a.status();
		await writeFile(join(root, "snippets.css"), "changed elsewhere");
		a.fs.put(`${CFG}/hotkeys.json`, '{"y":[]}');
		const s = await a.status();
		await writeFile(join(root, "other.txt"), "changed again");
		await expect(a.engine().push(s, s.result.outgoing, s.result.settledBase)).rejects.toBeInstanceOf(RemoteMovedError);
		expect(stale.remote.head).not.toBeNull();
	});

	it("deletes removed files and their empty folders, ignores dot files", async () => {
		await mkdir(join(root, ".git"));
		await writeFile(join(root, ".git/HEAD"), "ref");
		const a = vault("A");
		a.fs.put(`${CFG}/snippets/wide.css`, ".a{}");
		await a.push();
		expect(await readdir(join(root, "snippets"))).toEqual(["wide.css"]);
		await a.fs.remove(`${CFG}/snippets/wide.css`);
		await a.push();
		expect((await readdir(root)).sort()).toEqual([".git", "config", "profile.json"]);
		expect(await a.counts()).toEqual(inSync);
	});

	it("reports a missing folder clearly", async () => {
		root = join(root, "nope");
		await expect(vault("A").status()).rejects.toThrow(/does not exist/);
	});
});
