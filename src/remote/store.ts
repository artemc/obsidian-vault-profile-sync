/**
 * Where a profile lives. The engine only lists files, reads them by content id
 * and writes a batch on top of the version it compared against; GitHub and a
 * plain folder both fit behind this.
 */

import { emptyProfile, PROFILE_FILE, serializeProfile } from "../core/model";
import { profilePrefix } from "../engine/remote";
import type { CommitInfo, GitHubClient, TreeWrite } from "./github";

export interface StoreHead {
	/** Changes with every write; compared before writing. */
	version: string;
	/** Last change description and time, when the store keeps them. */
	message?: string;
	date?: string;
}

export interface StoreListing {
	head: StoreHead | null;
	/** Content id (git blob sha) by path relative to the profile root. */
	files: Map<string, string>;
}

export interface ProfileStore {
	list(): Promise<StoreListing>;
	read(id: string): Promise<Uint8Array>;
	/**
	 * Apply writes (paths relative to the profile root, null content deletes)
	 * on top of `head`. Throws RemoteMovedError if the store changed since.
	 * Returns the new version.
	 */
	write(head: StoreHead | null, writes: TreeWrite[], message: string): Promise<string>;
}

export class GitHubStore implements ProfileStore {
	private commits = new Map<string, CommitInfo>();

	constructor(
		readonly client: GitHubClient,
		readonly branch: string,
		readonly folder: string,
	) {}

	async list(): Promise<StoreListing> {
		const prefix = profilePrefix(this.folder);
		const head = await this.client.getHead(this.branch);
		const files = new Map<string, string>();
		if (head.kind !== "ok") return { head: null, files };
		const commit = await this.client.getCommit(head.sha);
		this.commits.set(commit.sha, commit);
		for (const e of await this.client.getTree(commit.treeSha)) {
			if (e.type === "blob" && e.path.startsWith(prefix)) files.set(e.path.slice(prefix.length), e.sha);
		}
		return { head: { version: commit.sha, message: commit.message, date: commit.date }, files };
	}

	read(id: string): Promise<Uint8Array> {
		return this.client.getBlob(id);
	}

	async write(head: StoreHead | null, writes: TreeWrite[], message: string): Promise<string> {
		const prefix = profilePrefix(this.folder);
		let parent = head ? (this.commits.get(head.version) ?? (await this.client.getCommit(head.version))) : null;
		if (!parent && (await this.client.getHead(this.branch)).kind === "empty-repo") {
			const sha = await this.client.bootstrapEmptyRepo(this.branch, prefix + PROFILE_FILE, serializeProfile(emptyProfile()));
			parent = await this.client.getCommit(sha);
		}
		return this.client.commit(this.branch, parent, writes.map((w) => ({ path: prefix + w.path, content: w.content })), message);
	}
}
