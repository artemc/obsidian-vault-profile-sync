/**
 * Reads the profile on GitHub into a snapshot. File items are hashed by their git
 * blob sha straight from the tree, so only profile.json is downloaded; other file
 * contents are fetched on demand (diff view, pull).
 */

import { utf8Decode } from "../core/canonical";
import type { ExcludeRules } from "../core/exclude";
import {
	emptyProfile,
	itemKey,
	parseProfile,
	pluginItem,
	PROFILE_FILE,
	repoPathToItem,
	settingsItem,
	SETTINGS_KEY,
	themeItem,
	type ProfileFile,
	type Snapshot,
} from "../core/model";
import type { CommitInfo, GitHubClient } from "../remote/github";

export interface RemoteState {
	/** Head commit of the branch, or null if the branch or the repository has no commits. */
	head: CommitInfo | null;
	emptyRepo: boolean;
	/** Blob sha by path relative to the profile folder. */
	files: Map<string, string>;
	profile: ProfileFile;
	profileExists: boolean;
	snapshot: Snapshot;
}

export function profilePrefix(folder: string): string {
	const f = folder.trim().replace(/^\/+|\/+$/g, "");
	return f ? `${f}/` : "";
}

export class RemoteReader {
	private blobCache = new Map<string, Uint8Array>();

	constructor(
		readonly client: GitHubClient,
		readonly branch: string,
		readonly folder: string,
	) {}

	get prefix(): string {
		return profilePrefix(this.folder);
	}

	async blob(sha: string): Promise<Uint8Array> {
		let b = this.blobCache.get(sha);
		if (!b) {
			b = await this.client.getBlob(sha);
			this.blobCache.set(sha, b);
		}
		return b;
	}

	async text(state: RemoteState, relPath: string): Promise<string> {
		const sha = state.files.get(relPath);
		if (!sha) throw new Error(`${relPath} is not in the profile.`);
		return utf8Decode(await this.blob(sha));
	}

	async read(exclude: ExcludeRules): Promise<RemoteState> {
		const head = await this.client.getHead(this.branch);
		const files = new Map<string, string>();
		let commit: CommitInfo | null = null;
		if (head.kind === "ok") {
			commit = await this.client.getCommit(head.sha);
			for (const e of await this.client.getTree(commit.treeSha)) {
				if (e.type !== "blob" || !e.path.startsWith(this.prefix)) continue;
				files.set(e.path.slice(this.prefix.length), e.sha);
			}
		}

		const profileSha = files.get(PROFILE_FILE);
		const profile = profileSha ? parseProfile(utf8Decode(await this.blob(profileSha))) : emptyProfile();
		const snapshot: Snapshot = new Map();

		for (const [path, sha] of files) {
			const item = repoPathToItem(path);
			if (!item) continue;
			const key = itemKey(item.kind, item.name);
			if (!exclude.isExcluded(key)) snapshot.set(key, { key, kind: item.kind, name: item.name, hash: sha });
		}
		for (const [id, entry] of Object.entries(profile.plugins)) {
			if (!exclude.isExcluded(itemKey("plugin", id))) snapshot.set(itemKey("plugin", id), await pluginItem(id, entry));
		}
		for (const [name, entry] of Object.entries(profile.themes)) {
			if (!exclude.isExcluded(itemKey("theme", name))) snapshot.set(itemKey("theme", name), await themeItem(name, entry));
		}
		if (profileSha) snapshot.set(SETTINGS_KEY, await settingsItem(profile.settings));

		return { head: commit, emptyRepo: head.kind === "empty-repo", files, profile, profileExists: !!profileSha, snapshot };
	}
}
