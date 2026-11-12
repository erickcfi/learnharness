/**
 * The source library on the volume (P5-01, C4, PD6): list, add or replace,
 * and remove files under <volume>/library/. Only the Owner's dashboard calls
 * this. Tenants read the library through upstream's file tools, locked to
 * it by lockdown (frontdoor/settings-template), and can never write it.
 *
 * Uploads stream to a private folder next to the library
 * (<volume>/.library-incoming/), are checked, then renamed into place, so a
 * tutor never sees half a file and a failed upload leaves nothing behind.
 */
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import type { Readable } from "node:stream";
import { COURSE_MAX_BYTES, parseCourseBytes } from "../course/file.ts";
import { checkRelativePath, cleanFileName, contentMatchesName, COURSE_AREA, courseUploadName, LIBRARY_AREAS, LIBRARY_MAX_BYTES, targetFolder } from "./rules.ts";

export interface LibraryFile {
	/** Path inside the library with forward slashes, for example "poh/c172s/POH.pdf". */
	relPath: string;
	area: string;
	/** The folder inside the area ("c172s" for poh/c172s), or "" for files at the area's top. */
	folder: string;
	name: string;
	bytes: number;
	modifiedAt: Date;
}

export class LibraryError extends Error {
	constructor(
		readonly code: "bad-request" | "exists" | "too-large" | "wrong-content" | "not-found",
		message: string,
	) {
		super(message);
	}
}

const MAX_DEPTH = 4;

/** Every file in the library's areas, sorted by path. Links and hidden files are skipped. */
export async function listLibrary(libraryDir: string): Promise<LibraryFile[]> {
	const out: LibraryFile[] = [];
	async function walk(rel: string[], depth: number): Promise<void> {
		let entries: fs.Dirent[];
		try {
			entries = await fsp.readdir(path.join(libraryDir, ...rel), { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			if (entry.name.startsWith(".") || entry.isSymbolicLink()) continue;
			const parts = [...rel, entry.name];
			if (entry.isDirectory() && depth < MAX_DEPTH) await walk(parts, depth + 1);
			else if (entry.isFile()) {
				const stat = await fsp.stat(path.join(libraryDir, ...parts));
				out.push({
					relPath: parts.join("/"),
					area: parts[0] ?? "",
					folder: parts.slice(1, -1).join("/"),
					name: entry.name,
					bytes: stat.size,
					modifiedAt: stat.mtime,
				});
			}
		}
	}
	for (const area of LIBRARY_AREAS) await walk([area], 1);
	return out.sort((a, b) => a.relPath.localeCompare(b.relPath));
}

/** True when `target` is inside `root` (both already resolved). */
function inside(root: string, target: string): boolean {
	return target.startsWith(root.endsWith(path.sep) ? root : root + path.sep);
}

/** The real library folder, made if missing. */
async function realLibrary(libraryDir: string): Promise<string> {
	await fsp.mkdir(libraryDir, { recursive: true });
	return fsp.realpath(libraryDir);
}

/** Make `rel` (a checked relative folder) inside the library, refusing any link on the way. */
async function ensureFolder(root: string, rel: string): Promise<string> {
	let current = root;
	for (const part of rel.split("/")) {
		current = path.join(current, part);
		try {
			const stat = await fsp.lstat(current);
			if (!stat.isDirectory()) throw new LibraryError("bad-request", "That folder name is taken by a file or a link.");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			await fsp.mkdir(current, { mode: 0o755 });
		}
	}
	if (!inside(root, await fsp.realpath(current))) throw new LibraryError("bad-request", "That folder is outside the library.");
	return current;
}

export interface SaveOptions {
	area: unknown;
	aircraft?: unknown;
	fileName: unknown;
	/** Replace a file of the same name (the Owner confirmed). */
	replace?: boolean;
	maxBytes?: number;
}

/**
 * Add or replace one file. Streams the body; refuses it when too large or when its bytes don't match its type.
 * The course area takes one .json file, stored as private-pilot.course.json, and only when it passes the
 * course file check (frontdoor/course/file.ts).
 */
export async function saveLibraryFile(libraryDir: string, body: Readable, options: SaveOptions): Promise<{ file: LibraryFile; replaced: boolean }> {
	const course = options.area === COURSE_AREA;
	const maxBytes = options.maxBytes ?? (course ? COURSE_MAX_BYTES : LIBRARY_MAX_BYTES);
	const folder = targetFolder(options.area, options.aircraft);
	if (!folder.ok) throw new LibraryError("bad-request", folder.error);
	const name = course ? courseUploadName(options.fileName) : cleanFileName(options.fileName);
	if (!name) {
		throw new LibraryError(
			"bad-request",
			course ? "The Course area takes one file: the course .json file." : "Use a PDF, text (.md, .txt, .csv) or image (.png, .jpg, .gif, .webp) file.",
		);
	}

	const root = await realLibrary(libraryDir);
	const dir = await ensureFolder(root, folder.folder);
	const target = path.join(dir, name);
	let existed = false;
	try {
		const stat = await fsp.lstat(target);
		if (!stat.isFile()) throw new LibraryError("bad-request", "That name is taken by a folder or a link.");
		existed = true;
	} catch (error) {
		if (error instanceof LibraryError) throw error;
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	if (existed && !options.replace) throw new LibraryError("exists", `${name} is already in the library.`);

	const incoming = path.join(path.dirname(root), ".library-incoming");
	await fsp.mkdir(incoming, { recursive: true, mode: 0o700 });
	const temp = path.join(incoming, `${randomUUID()}.part`);
	const head: Buffer[] = [];
	let headBytes = 0;
	let size = 0;
	try {
		await new Promise<void>((resolve, reject) => {
			const out = fs.createWriteStream(temp, { flags: "wx", mode: 0o644 });
			let failed = false;
			const fail = (error: Error) => {
				if (failed) return;
				failed = true;
				body.unpipe(out);
				body.resume();
				out.destroy();
				reject(error);
			};
			body.on("data", (chunk: Buffer) => {
				size += chunk.length;
				if (headBytes < 16) {
					head.push(chunk);
					headBytes += chunk.length;
				}
				if (size > maxBytes) fail(new LibraryError("too-large", `Files can be up to ${Math.round(maxBytes / (1024 * 1024))} MB.`));
			});
			body.on("error", fail);
			out.on("error", fail);
			out.on("finish", () => {
				if (!failed) resolve();
			});
			body.pipe(out);
		});
		if (size === 0) throw new LibraryError("bad-request", "The file is empty.");
		if (course) {
			const checked = parseCourseBytes(await fsp.readFile(temp));
			if (!checked.ok) throw new LibraryError("wrong-content", `This is not a valid course file: ${checked.error}.`);
		} else if (!contentMatchesName(name, Buffer.concat(head).subarray(0, 16))) {
			throw new LibraryError("wrong-content", `${name} does not look like the type its name says.`);
		}
		await fsp.rename(temp, target);
	} catch (error) {
		await fsp.rm(temp, { force: true });
		throw error;
	}
	const stat = await fsp.stat(target);
	const relPath = `${folder.folder}/${name}`;
	const [area = "", ...rest] = folder.folder.split("/");
	return { file: { relPath, area, folder: rest.join("/"), name, bytes: stat.size, modifiedAt: stat.mtime }, replaced: existed };
}

/** Remove one library file the Owner confirmed. Refuses folders, links and anything outside the library. */
export async function removeLibraryFile(libraryDir: string, relPath: unknown): Promise<void> {
	const rel = checkRelativePath(relPath);
	if (!rel) throw new LibraryError("bad-request", "That is not a library file.");
	const root = await realLibrary(libraryDir);
	const target = path.join(root, ...rel.split("/"));
	let stat: fs.Stats;
	try {
		stat = await fsp.lstat(target);
	} catch {
		throw new LibraryError("not-found", "That file is not in the library.");
	}
	if (!stat.isFile()) throw new LibraryError("bad-request", "Only files can be removed here.");
	if (!inside(root, await fsp.realpath(path.dirname(target)))) throw new LibraryError("bad-request", "That file is outside the library.");
	await fsp.unlink(target);
}
