/**
 * Narrow interfaces the sync engine depends on. In Obsidian they are backed by the
 * vault adapter, requestUrl and the app's plugin manager (see obsidian-host.ts);
 * in tests by in-memory fakes.
 */

export interface ListedFiles {
	files: string[];
	folders: string[];
}

/** Subset of Obsidian's DataAdapter. Paths are vault-relative, as list() returns them. */
export interface Fs {
	exists(path: string): Promise<boolean>;
	read(path: string): Promise<string>;
	write(path: string, data: string): Promise<void>;
	readBinary(path: string): Promise<ArrayBuffer>;
	writeBinary(path: string, data: ArrayBuffer): Promise<void>;
	list(path: string): Promise<ListedFiles>;
	remove(path: string): Promise<void>;
	rmdir(path: string, recursive: boolean): Promise<void>;
	mkdir(path: string): Promise<void>;
}

export interface HttpRequest {
	url: string;
	method?: string;
	headers?: Record<string, string>;
	body?: string;
	contentType?: string;
}

export interface HttpResponse {
	status: number;
	text: string;
	arrayBuffer: ArrayBuffer;
}

/** Never throws on HTTP status codes; network failures reject. */
export type Http = (req: HttpRequest) => Promise<HttpResponse>;

/** Things only the running app can do. Every method must degrade gracefully. */
export interface Host {
	isPluginLoaded(id: string): boolean;
	/** Unload a plugin without changing its enabled state on disk. */
	disablePlugin(id: string): Promise<void>;
}

export function parentDir(path: string): string {
	const i = path.lastIndexOf("/");
	return i < 0 ? "" : path.slice(0, i);
}

export function baseName(path: string): string {
	return path.slice(path.lastIndexOf("/") + 1);
}

export function joinPath(...parts: string[]): string {
	return parts.filter((p) => p.length > 0).join("/");
}

export async function ensureDir(fs: Fs, dir: string): Promise<void> {
	if (!dir || (await fs.exists(dir))) return;
	await ensureDir(fs, parentDir(dir));
	await fs.mkdir(dir);
}

export async function writeText(fs: Fs, path: string, text: string): Promise<void> {
	await ensureDir(fs, parentDir(path));
	await fs.write(path, text);
}

export async function writeBytes(fs: Fs, path: string, bytes: Uint8Array): Promise<void> {
	await ensureDir(fs, parentDir(path));
	const copy = new Uint8Array(bytes.byteLength);
	copy.set(bytes);
	await fs.writeBinary(path, copy.buffer);
}

export async function readTextIfExists(fs: Fs, path: string): Promise<string | null> {
	return (await fs.exists(path)) ? fs.read(path) : null;
}

/** All files under dir, recursively. */
export async function listRecursive(fs: Fs, dir: string): Promise<string[]> {
	if (!(await fs.exists(dir))) return [];
	const { files, folders } = await fs.list(dir);
	const nested = await Promise.all(folders.map((f) => listRecursive(fs, f)));
	return [...files, ...nested.flat()];
}
