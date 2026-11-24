/**
 * Minimal GitHub REST client for the profile repository.
 * Reads use refs, commits, recursive trees and blobs; a push is one commit built
 * with the Git Data API and published with a non-forced ref update.
 */

import { base64Decode, base64Encode, utf8Encode } from "../core/canonical";
import type { Http, HttpResponse } from "../io";

const API = "https://api.github.com";

export class GitHubError extends Error {
	constructor(
		message: string,
		readonly status: number,
	) {
		super(message);
		this.name = "GitHubError";
	}
}

/** The branch moved after the comparison was made; the caller must compare again. */
export class RemoteMovedError extends Error {
	constructor() {
		super("The profile changed on GitHub while you were reviewing. Compare again.");
		this.name = "RemoteMovedError";
	}
}

export interface RepoInfo {
	defaultBranch: string;
	isPrivate: boolean;
	canPush: boolean;
	empty: boolean;
}

export interface CommitInfo {
	sha: string;
	treeSha: string;
	message: string;
	date: string;
}

export interface TreeEntry {
	path: string;
	sha: string;
	type: "blob" | "tree" | "commit";
}

/** A change in a new tree: text content, or null to delete the path. */
export interface TreeWrite {
	path: string;
	content: string | null;
}

export type HeadResult = { kind: "ok"; sha: string } | { kind: "no-branch" } | { kind: "empty-repo" };

export function parseRepo(value: string): { owner: string; name: string } | null {
	const cleaned = value
		.trim()
		.replace(/^https?:\/\/github\.com\//i, "")
		.replace(/\.git$/i, "")
		.replace(/\/+$/, "");
	const m = /^([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+)$/.exec(cleaned);
	return m ? { owner: m[1], name: m[2] } : null;
}

export class GitHubClient {
	private readonly base: string;

	constructor(
		private readonly http: Http,
		readonly owner: string,
		readonly repo: string,
		private readonly token: string,
	) {
		this.base = `${API}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
	}

	private async call(method: string, path: string, body?: unknown): Promise<HttpResponse> {
		return this.http({
			url: `${this.base}${path}`,
			method,
			headers: {
				Accept: "application/vnd.github+json",
				Authorization: `Bearer ${this.token}`,
				"X-GitHub-Api-Version": "2022-11-28",
			},
			contentType: body === undefined ? undefined : "application/json",
			body: body === undefined ? undefined : JSON.stringify(body),
		});
	}

	private fail(what: string, res: HttpResponse): never {
		let detail = "";
		try {
			detail = (JSON.parse(res.text) as { message?: string }).message ?? "";
		} catch {
			detail = res.text.slice(0, 200);
		}
		const hint =
			res.status === 401
				? " Check the GitHub token."
				: res.status === 403 || res.status === 404
					? " Check the repository name and that the token has Contents: read and write access to it."
					: "";
		throw new GitHubError(`GitHub: ${what} failed (${res.status}${detail ? `: ${detail}` : ""}).${hint}`, res.status);
	}

	private async json<T>(what: string, method: string, path: string, body?: unknown, ok = [200, 201]): Promise<T> {
		const res = await this.call(method, path, body);
		if (!ok.includes(res.status)) this.fail(what, res);
		return JSON.parse(res.text) as T;
	}

	async getRepo(): Promise<RepoInfo> {
		const r = await this.json<{ default_branch: string; private: boolean; permissions?: { push?: boolean }; size: number }>(
			"reading the repository",
			"GET",
			"",
		);
		const head = await this.call("GET", `/git/ref/heads/${encodeURIComponent(r.default_branch)}`);
		return {
			defaultBranch: r.default_branch,
			isPrivate: r.private,
			canPush: r.permissions?.push === true,
			empty: head.status === 409 || (head.status === 404 && r.size === 0),
		};
	}

	async getHead(branch: string): Promise<HeadResult> {
		const res = await this.call("GET", `/git/ref/heads/${encodeURIComponent(branch)}`);
		if (res.status === 200) return { kind: "ok", sha: (JSON.parse(res.text) as { object: { sha: string } }).object.sha };
		if (res.status === 409) return { kind: "empty-repo" };
		if (res.status === 404) {
			// Either the branch is missing or the repository is empty / inaccessible.
			const repo = await this.getRepo();
			return repo.empty ? { kind: "empty-repo" } : { kind: "no-branch" };
		}
		this.fail("reading the branch", res);
	}

	async getCommit(sha: string): Promise<CommitInfo> {
		const c = await this.json<{ sha: string; tree: { sha: string }; message: string; committer: { date: string } }>(
			"reading a commit",
			"GET",
			`/git/commits/${sha}`,
		);
		return { sha: c.sha, treeSha: c.tree.sha, message: c.message, date: c.committer.date };
	}

	async getTree(treeSha: string): Promise<TreeEntry[]> {
		const t = await this.json<{ tree: TreeEntry[]; truncated: boolean }>("reading the file tree", "GET", `/git/trees/${treeSha}?recursive=1`);
		if (t.truncated) throw new GitHubError("GitHub: the repository tree is too large to read in one request.", 200);
		return t.tree;
	}

	async getBlob(sha: string): Promise<Uint8Array> {
		const b = await this.json<{ content: string; encoding: string }>("downloading a file", "GET", `/git/blobs/${sha}`);
		if (b.encoding !== "base64") return utf8Encode(b.content);
		return base64Decode(b.content);
	}

	/**
	 * Commit the writes on top of parent (or as a root commit when parent is null)
	 * and move the branch. Returns the new commit sha.
	 */
	async commit(branch: string, parent: CommitInfo | null, writes: TreeWrite[], message: string): Promise<string> {
		const tree = writes.map((w) =>
			w.content === null
				? { path: w.path, mode: "100644", type: "blob", sha: null }
				: { path: w.path, mode: "100644", type: "blob", content: w.content },
		);
		const newTree = await this.json<{ sha: string }>("creating the file tree", "POST", "/git/trees", {
			...(parent ? { base_tree: parent.treeSha } : {}),
			tree,
		});
		const commit = await this.json<{ sha: string }>("creating the commit", "POST", "/git/commits", {
			message,
			tree: newTree.sha,
			parents: parent ? [parent.sha] : [],
		});
		if (parent) {
			const res = await this.call("PATCH", `/git/refs/heads/${encodeURIComponent(branch)}`, { sha: commit.sha, force: false });
			if (res.status === 422 || res.status === 409) throw new RemoteMovedError();
			if (res.status !== 200) this.fail("updating the branch", res);
		} else {
			const res = await this.call("POST", "/git/refs", { ref: `refs/heads/${branch}`, sha: commit.sha });
			if (res.status === 422) throw new RemoteMovedError();
			if (res.status !== 201) this.fail("creating the branch", res);
		}
		return commit.sha;
	}

	/**
	 * The Git Data API does not work on a repository without commits, so the first
	 * commit is made with the Contents API. Returns the head sha of `branch` afterwards.
	 */
	async bootstrapEmptyRepo(branch: string, path: string, content: string): Promise<string> {
		const res = await this.json<{ commit: { sha: string } }>(
			"creating the first commit",
			"PUT",
			`/contents/${path.split("/").map(encodeURIComponent).join("/")}`,
			{ message: "Create settings profile", content: base64Encode(utf8Encode(content)) },
		);
		const repo = await this.getRepo();
		if (repo.defaultBranch !== branch) {
			const created = await this.call("POST", "/git/refs", { ref: `refs/heads/${branch}`, sha: res.commit.sha });
			if (created.status !== 201) this.fail("creating the branch", created);
		}
		return res.commit.sha;
	}
}
