import { utf8Decode, utf8Encode } from "../../src/core/canonical";
import { parentDir, type Fs, type ListedFiles } from "../../src/io";

/** In-memory vault adapter. Like Obsidian's, list() returns full paths; write() needs the parent folder. */
export class MemFs implements Fs {
	files = new Map<string, Uint8Array>();
	dirs = new Set<string>([""]);

	private needParent(path: string): void {
		if (!this.dirs.has(parentDir(path))) throw new Error(`ENOENT: parent folder of ${path} does not exist`);
	}

	async exists(path: string): Promise<boolean> {
		return this.files.has(path) || this.dirs.has(path);
	}
	async read(path: string): Promise<string> {
		const f = this.files.get(path);
		if (!f) throw new Error(`ENOENT: ${path}`);
		return utf8Decode(f);
	}
	async write(path: string, data: string): Promise<void> {
		this.needParent(path);
		this.files.set(path, utf8Encode(data));
	}
	async readBinary(path: string): Promise<ArrayBuffer> {
		const f = this.files.get(path);
		if (!f) throw new Error(`ENOENT: ${path}`);
		return f.slice().buffer;
	}
	async writeBinary(path: string, data: ArrayBuffer): Promise<void> {
		this.needParent(path);
		this.files.set(path, new Uint8Array(data.slice(0)));
	}
	async list(path: string): Promise<ListedFiles> {
		if (!this.dirs.has(path)) throw new Error(`ENOENT: ${path}`);
		const prefix = path ? `${path}/` : "";
		const direct = (p: string) => p.startsWith(prefix) && p !== path && !p.slice(prefix.length).includes("/");
		return { files: [...this.files.keys()].filter(direct).sort(), folders: [...this.dirs].filter(direct).sort() };
	}
	async remove(path: string): Promise<void> {
		if (!this.files.delete(path)) throw new Error(`ENOENT: ${path}`);
	}
	async rmdir(path: string, recursive: boolean): Promise<void> {
		const prefix = `${path}/`;
		const inside = [...this.files.keys(), ...this.dirs].filter((p) => p.startsWith(prefix));
		if (inside.length > 0 && !recursive) throw new Error(`ENOTEMPTY: ${path}`);
		for (const f of [...this.files.keys()]) if (f.startsWith(prefix)) this.files.delete(f);
		for (const d of [...this.dirs]) if (d.startsWith(prefix)) this.dirs.delete(d);
		this.dirs.delete(path);
	}
	async mkdir(path: string): Promise<void> {
		this.needParent(path);
		this.dirs.add(path);
	}

	// test helpers
	put(path: string, text: string): void {
		let d = parentDir(path);
		const chain: string[] = [];
		while (d && !this.dirs.has(d)) {
			chain.push(d);
			d = parentDir(d);
		}
		for (const c of chain.reverse()) this.dirs.add(c);
		this.files.set(path, utf8Encode(text));
	}
	text(path: string): string | undefined {
		const f = this.files.get(path);
		return f ? utf8Decode(f) : undefined;
	}
	json(path: string): unknown {
		const t = this.text(path);
		return t === undefined ? undefined : JSON.parse(t);
	}
}
