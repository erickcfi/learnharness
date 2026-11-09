/** Current optional learner-source preferences, wired by the server
 * composition root into the #157 policy seam. Mandatory #421 protection
 * stays in fs-shared; do NOT add a whole data/userData denial here. */
import os from "node:os";
import path from "node:path";
import type { FileAccessPolicy } from "../agent/tools/file-access.ts";
import { readFileAccessSettings } from "../store/settings.ts";

export function expandFolder(folder: string, home: string = os.homedir()): string {
	if (folder === "~") return home;
	if (folder.startsWith("~/")) return path.join(home, folder.slice(2));
	if (!path.isAbsolute(folder)) throw new Error("Invalid file-access folder for this server filesystem");
	return path.resolve(folder);
}

/** North Aero fork (PRD C5, docs/upstream-changes.md): the front door sets
 * LH_LIBRARY_DIR, which fixes File access to that one folder whatever
 * settings.json says. An empty or relative value blocks every read. */
function lockedLibraryPolicy(): FileAccessPolicy | null {
	const library = process.env.LH_LIBRARY_DIR;
	if (library === undefined) return null;
	if (!path.isAbsolute(library)) return { restricted: true, folders: [], error: "File-access configuration error: LH_LIBRARY_DIR must be an absolute path. Learner-file access is blocked." };
	return { restricted: true, folders: [path.resolve(library)] };
}

export function fileAccessPolicy(): FileAccessPolicy {
	const locked = lockedLibraryPolicy();
	if (locked) return locked;
	const result = readFileAccessSettings();
	if (!result.ok) return { restricted: true, folders: [], error: result.error };
	return { restricted: result.settings.restricted, folders: result.settings.folders.map((folder) => expandFolder(folder)) };
}

/** Safe UI diagnostic, no raw JSON/file contents. A corrupt record must
 * not make the restriction toggle appear safely OFF while reads are blocked. */
export function fileAccessConfigurationError(): string | null {
	const result = readFileAccessSettings();
	return result.ok ? null : result.error;
}
