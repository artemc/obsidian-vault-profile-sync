/**
 * Backups taken before a pull, so the last pull can be undone.
 * A backup stores the previous bytes of every path the pull writes or deletes,
 * which paths did not exist before, the folders the pull creates, and the base.
 */

import type { Base } from "../core/classify";
import { canonicalJson, tryParseJson } from "../core/canonical";
import { ensureDir, joinPath, writeBytes, type Fs } from "../io";

export const KEEP_BACKUPS = 5;

interface BackupEntry {
	path: string;
	existed: boolean;
	file?: string;
}

interface BackupMeta {
	created: string;
	label: string;
	base: Base;
	entries: BackupEntry[];
	createdDirs: string[];
}

export interface BackupSummary {
	dir: string;
	created: string;
	label: string;
	files: number;
}

export class BackupStore {
	constructor(
		private readonly fs: Fs,
		readonly root: string,
	) {}

	async create(label: string, base: Base, paths: string[], createdDirs: string[]): Promise<string> {
		const stamp = new Date().toISOString().replace(/[:.]/g, "-");
		const dir = joinPath(this.root, stamp);
		await ensureDir(this.fs, dir);
		const entries: BackupEntry[] = [];
		let n = 0;
		for (const path of [...new Set(paths)]) {
			if (await this.fs.exists(path)) {
				const file = `files/${n++}`;
				await writeBytes(this.fs, joinPath(dir, file), new Uint8Array(await this.fs.readBinary(path)));
				entries.push({ path, existed: true, file });
			} else {
				entries.push({ path, existed: false });
			}
		}
		const meta: BackupMeta = { created: new Date().toISOString(), label, base, entries, createdDirs };
		await this.fs.write(joinPath(dir, "meta.json"), canonicalJson(meta));
		await this.prune();
		return dir;
	}

	private async dirs(): Promise<string[]> {
		if (!(await this.fs.exists(this.root))) return [];
		return (await this.fs.list(this.root)).folders.sort();
	}

	private async prune(): Promise<void> {
		const dirs = await this.dirs();
		for (const d of dirs.slice(0, Math.max(0, dirs.length - KEEP_BACKUPS))) await this.fs.rmdir(d, true);
	}

	private async meta(dir: string): Promise<BackupMeta | null> {
		const path = joinPath(dir, "meta.json");
		if (!(await this.fs.exists(path))) return null;
		return (tryParseJson(await this.fs.read(path)) as unknown as BackupMeta) ?? null;
	}

	async list(): Promise<BackupSummary[]> {
		const out: BackupSummary[] = [];
		for (const dir of (await this.dirs()).reverse()) {
			const m = await this.meta(dir);
			if (m) out.push({ dir, created: m.created, label: m.label, files: m.entries.length });
		}
		return out;
	}

	/** Restore the newest backup, delete it and return the base it recorded. */
	async restoreLatest(): Promise<Base | null> {
		const dirs = await this.dirs();
		const dir = dirs[dirs.length - 1];
		if (!dir) return null;
		const m = await this.meta(dir);
		if (!m) return null;
		for (const e of m.entries) {
			if (e.existed && e.file) {
				await writeBytes(this.fs, e.path, new Uint8Array(await this.fs.readBinary(joinPath(dir, e.file))));
			} else if (await this.fs.exists(e.path)) {
				await this.fs.remove(e.path);
			}
		}
		for (const d of [...m.createdDirs].sort().reverse()) {
			if ((await this.fs.exists(d)) && (await this.isEmptyDir(d))) await this.fs.rmdir(d, false);
		}
		await this.fs.rmdir(dir, true);
		return m.base;
	}

	private async isEmptyDir(dir: string): Promise<boolean> {
		const l = await this.fs.list(dir);
		return l.files.length === 0 && l.folders.length === 0;
	}
}
