import { base64Decode, base64Encode, gitBlobSha, sha1Hex, utf8Decode, utf8Encode } from "../../src/core/canonical";
import type { Http, HttpRequest, HttpResponse } from "../../src/io";

interface Commit {
	sha: string;
	tree: string;
	parents: string[];
	message: string;
}

function res(status: number, body: unknown): HttpResponse {
	const text = typeof body === "string" ? body : JSON.stringify(body);
	const bytes = utf8Encode(text);
	return { status, text, arrayBuffer: bytes.slice().buffer };
}

function bin(bytes: Uint8Array): HttpResponse {
	return { status: 200, text: utf8Decode(bytes), arrayBuffer: bytes.slice().buffer };
}

/**
 * In-memory GitHub: the Git Data endpoints the plugin uses, the Contents PUT used
 * for an empty repository, the Obsidian catalogs and release downloads.
 * Trees are stored flat (path -> blob sha); blob shas are real git blob ids.
 */
export class FakeGitHub {
	blobs = new Map<string, Uint8Array>();
	trees = new Map<string, Map<string, string>>();
	commits = new Map<string, Commit>();
	refs = new Map<string, string>();
	defaultBranch = "main";
	plugins: { id: string; repo: string }[] = [];
	themes: { name: string; repo: string }[] = [];
	/** url -> file content for release / raw downloads */
	downloads = new Map<string, Uint8Array>();
	requests: string[] = [];
	private counter = 0;

	constructor(
		readonly owner = "me",
		readonly repo = "profile",
	) {}

	/** Publish a plugin release that the catalog points to. */
	release(id: string, version: string, tag = version, extra: Record<string, string> = {}): void {
		const repo = `dev/${id}`;
		if (!this.plugins.some((p) => p.id === id)) this.plugins.push({ id, repo });
		const base = `https://github.com/${repo}/releases/download/${tag}`;
		this.downloads.set(`${base}/main.js`, utf8Encode(`// ${id} ${version}\n`));
		this.downloads.set(`${base}/manifest.json`, utf8Encode(JSON.stringify({ id, name: id, version })));
		for (const [f, t] of Object.entries(extra)) this.downloads.set(`${base}/${f}`, utf8Encode(t));
	}

	head(branch = this.defaultBranch): string | undefined {
		return this.refs.get(branch);
	}

	/** Files of the branch head, path -> text. */
	snapshot(branch = this.defaultBranch): Map<string, string> {
		const out = new Map<string, string>();
		const head = this.refs.get(branch);
		if (!head) return out;
		const tree = this.trees.get(this.commits.get(head)!.tree)!;
		for (const [p, sha] of tree) out.set(p, utf8Decode(this.blobs.get(sha)!));
		return out;
	}

	private async putBlob(bytes: Uint8Array): Promise<string> {
		const sha = await gitBlobSha(bytes);
		this.blobs.set(sha, bytes);
		return sha;
	}

	private async putTree(entries: Map<string, string>): Promise<string> {
		const listing = [...entries].sort().map(([p, s]) => `${p}:${s}`).join("\n");
		const sha = await sha1Hex(utf8Encode(`tree ${listing}`));
		this.trees.set(sha, new Map(entries));
		return sha;
	}

	private async putCommit(tree: string, parents: string[], message: string): Promise<string> {
		const sha = await sha1Hex(utf8Encode(`commit ${tree} ${parents.join(",")} ${message} ${this.counter++}`));
		this.commits.set(sha, { sha, tree, parents, message });
		return sha;
	}

	/** Commit files directly, as another vault or a person on github.com would. */
	async commitFiles(files: Record<string, string | null>, branch = this.defaultBranch): Promise<string> {
		const head = this.refs.get(branch);
		const entries = new Map(head ? this.trees.get(this.commits.get(head)!.tree)! : []);
		for (const [p, t] of Object.entries(files)) {
			if (t === null) entries.delete(p);
			else entries.set(p, await this.putBlob(utf8Encode(t)));
		}
		const sha = await this.putCommit(await this.putTree(entries), head ? [head] : [], "external");
		this.refs.set(branch, sha);
		return sha;
	}

	http: Http = async (req: HttpRequest) => this.handle(req);

	private async handle(req: HttpRequest): Promise<HttpResponse> {
		const method = req.method ?? "GET";
		this.requests.push(`${method} ${req.url}`);
		const dl = this.downloads.get(req.url);
		if (dl) return bin(dl);
		if (req.url === "https://raw.githubusercontent.com/obsidianmd/obsidian-releases/HEAD/community-plugins.json") return res(200, this.plugins);
		if (req.url === "https://raw.githubusercontent.com/obsidianmd/obsidian-releases/HEAD/community-css-themes.json") return res(200, this.themes);

		const api = `https://api.github.com/repos/${this.owner}/${this.repo}`;
		if (!req.url.startsWith(api)) return res(404, { message: "Not Found" });
		if (req.headers?.Authorization !== "Bearer tok") return res(401, { message: "Bad credentials" });
		const path = req.url.slice(api.length);
		const body = req.body ? JSON.parse(req.body) : undefined;
		const empty = this.refs.size === 0;
		let m: RegExpExecArray | null;

		if (path === "" && method === "GET") return res(200, { default_branch: this.defaultBranch, private: true, permissions: { push: true }, size: empty ? 0 : 1 });
		if ((m = /^\/git\/ref\/heads\/(.+)$/.exec(path)) && method === "GET") {
			if (empty) return res(409, { message: "Git Repository is empty." });
			const sha = this.refs.get(decodeURIComponent(m[1]));
			return sha ? res(200, { object: { sha } }) : res(404, { message: "Not Found" });
		}
		if ((m = /^\/git\/commits\/(\w+)$/.exec(path)) && method === "GET") {
			const c = this.commits.get(m[1]);
			return c ? res(200, { sha: c.sha, tree: { sha: c.tree }, message: c.message, committer: { date: "2026-11-24T00:00:00Z" } }) : res(404, {});
		}
		if ((m = /^\/git\/trees\/(\w+)\?recursive=1$/.exec(path)) && method === "GET") {
			const t = this.trees.get(m[1]);
			if (!t) return res(404, {});
			return res(200, { tree: [...t].map(([p, sha]) => ({ path: p, sha, type: "blob" })), truncated: false });
		}
		if ((m = /^\/git\/blobs\/(\w+)$/.exec(path)) && method === "GET") {
			const b = this.blobs.get(m[1]);
			return b ? res(200, { content: base64Encode(b), encoding: "base64" }) : res(404, {});
		}
		if (empty && path.startsWith("/git/")) return res(409, { message: "Git Repository is empty." });
		if (path === "/git/trees" && method === "POST") {
			const entries = new Map(body.base_tree ? this.trees.get(body.base_tree)! : []);
			for (const e of body.tree as { path: string; sha?: string | null; content?: string }[]) {
				if (e.sha === null) {
					if (!entries.has(e.path)) return res(422, { message: `path ${e.path} does not exist` });
					entries.delete(e.path);
				} else if (e.content !== undefined) entries.set(e.path, await this.putBlob(utf8Encode(e.content)));
				else entries.set(e.path, e.sha!);
			}
			return res(201, { sha: await this.putTree(entries) });
		}
		if (path === "/git/commits" && method === "POST") {
			return res(201, { sha: await this.putCommit(body.tree, body.parents, body.message) });
		}
		if ((m = /^\/git\/refs\/heads\/(.+)$/.exec(path)) && method === "PATCH") {
			const branch = decodeURIComponent(m[1]);
			const current = this.refs.get(branch);
			const commit = this.commits.get(body.sha)!;
			if (!body.force && (!current || !commit.parents.includes(current))) return res(422, { message: "Update is not a fast forward" });
			this.refs.set(branch, body.sha);
			return res(200, { object: { sha: body.sha } });
		}
		if (path === "/git/refs" && method === "POST") {
			const branch = (body.ref as string).replace(/^refs\/heads\//, "");
			if (this.refs.has(branch)) return res(422, { message: "Reference already exists" });
			this.refs.set(branch, body.sha);
			return res(201, {});
		}
		if ((m = /^\/contents\/(.+)$/.exec(path)) && method === "PUT") {
			const p = m[1].split("/").map(decodeURIComponent).join("/");
			const sha = await this.putBlob(base64Decode(body.content));
			const head = this.refs.get(this.defaultBranch);
			const entries = new Map(head ? this.trees.get(this.commits.get(head)!.tree)! : []);
			entries.set(p, sha);
			const commit = await this.putCommit(await this.putTree(entries), head ? [head] : [], body.message);
			this.refs.set(this.defaultBranch, commit);
			return res(201, { commit: { sha: commit } });
		}
		return res(404, { message: `fake: no route ${method} ${path}` });
	}
}
