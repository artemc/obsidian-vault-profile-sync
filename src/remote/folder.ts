/**
 * A profile in a plain folder: a local disk, a synced folder (Dropbox, iCloud)
 * or a network share mounted by the system. No git: the version is a hash of
 * the file list, so a write on top of a stale comparison is refused just like
 * a push on GitHub. Names starting with a dot (.git, .DS_Store) are ignored,
 * so the folder may also be a git working copy.
 */

import { gitBlobSha, sha1Hex, utf8Encode } from "../core/canonical";
import type { TreeWrite } from "./github";
import { RemoteMovedError } from "./github";
import type { ProfileStore, StoreHead, StoreListing } from "./store";

interface DirEntry {
	name: string;
	isDirectory(): boolean;
	isFile(): boolean;
}

/** The part of Node's fs/promises the folder store needs. */
export interface DiskFs {
	readdir(path: string, opts: { withFileTypes: true }): Promise<DirEntry[]>;
	readFile(path: string): Promise<Uint8Array>;
	writeFile(path: string, data: Uint8Array): Promise<void>;
	mkdir(path: string, opts: { recursive: true }): Promise<unknown>;
	rename(from: string, to: string): Promise<void>;
	unlink(path: string): Promise<void>;
	rmdir(path: string): Promise<void>;
	stat(path: string): Promise<{ isDirectory(): boolean }>;
}

export class FolderStore implements ProfileStore {
	private paths = new Map<string, string>();

	constructor(
		private readonly disk: DiskFs,
		readonly root: string,
	) {}

	private abs(rel: string): string {
		return `${this.root.replace(/[\\/]+$/, "")}/${rel}`;
	}

	/** Throws a readable error when the folder is missing. */
	async check(): Promise<void> {
		let ok = false;
		try {
			ok = (await this.disk.stat(this.root)).isDirectory();
		} catch {
			ok = false;
		}
		if (!ok) throw new Error(`Folder ${this.root} does not exist or is not reachable.`);
	}

	private async walk(rel: string, out: string[]): Promise<void> {
		for (const e of await this.disk.readdir(rel ? this.abs(rel) : this.root, { withFileTypes: true })) {
			if (e.name.startsWith(".")) continue;
			const p = rel ? `${rel}/${e.name}` : e.name;
			if (e.isDirectory()) await this.walk(p, out);
			else if (e.isFile()) out.push(p);
		}
	}

	async list(): Promise<StoreListing> {
		await this.check();
		const names: string[] = [];
		await this.walk("", names);
		names.sort();
		const files = new Map<string, string>();
		this.paths.clear();
		for (const p of names) {
			const id = await gitBlobSha(await this.disk.readFile(this.abs(p)));
			files.set(p, id);
			this.paths.set(id, p);
		}
		if (files.size === 0) return { head: null, files };
		const version = await sha1Hex(utf8Encode([...files].map(([p, id]) => `${id} ${p}`).join("\n")));
		return { head: { version }, files };
	}

	async read(id: string): Promise<Uint8Array> {
		if (!this.paths.has(id)) await this.list();
		const p = this.paths.get(id);
		if (!p) throw new Error(`File ${id} is not in the profile folder.`);
		return this.disk.readFile(this.abs(p));
	}

	async write(head: StoreHead | null, writes: TreeWrite[], _message: string): Promise<string> {
		const now = await this.list();
		if ((now.head?.version ?? null) !== (head?.version ?? null)) throw new RemoteMovedError();
		for (const w of writes) {
			const target = this.abs(w.path);
			if (w.content === null) {
				if (now.files.has(w.path)) await this.disk.unlink(target);
				await this.pruneDirs(w.path);
				continue;
			}
			await this.disk.mkdir(target.slice(0, target.lastIndexOf("/")), { recursive: true });
			const tmp = `${target}.vps-tmp`;
			await this.disk.writeFile(tmp, utf8Encode(w.content));
			await this.disk.rename(tmp, target);
		}
		return (await this.list()).head?.version ?? "";
	}

	/** Remove folders left empty by deletes, up to the root. */
	private async pruneDirs(rel: string): Promise<void> {
		let dir = rel.slice(0, Math.max(0, rel.lastIndexOf("/")));
		while (dir) {
			try {
				if ((await this.disk.readdir(this.abs(dir), { withFileTypes: true })).length > 0) return;
				await this.disk.rmdir(this.abs(dir));
			} catch {
				return;
			}
			dir = dir.slice(0, Math.max(0, dir.lastIndexOf("/")));
		}
	}
}
