/**
 * What the Owner may put in the source library, and where (P5-01, C4
 * req 1 and 3, PD6). The tutors read the library through upstream's file
 * tools, so only types those tools read are allowed: PDF (the pdf job),
 * text (the read tool) and images (the read tool).
 *
 * Layout (C4 req 1): faa/, ntsb/, poh/<aircraft>/, north-aero/.
 */
import { LIBRARY_SUBFOLDERS } from "../settings-template/file-access.ts";

export const LIBRARY_AREAS = LIBRARY_SUBFOLDERS;
export type LibraryArea = (typeof LIBRARY_AREAS)[number];

export const AREA_LABELS: Record<LibraryArea, string> = {
	faa: "FAA",
	ntsb: "NTSB",
	poh: "POH",
	"north-aero": "North Aero",
};

export const LIBRARY_EXTENSIONS = [".pdf", ".md", ".txt", ".csv", ".png", ".jpg", ".jpeg", ".gif", ".webp"] as const;
/** FAA handbooks run 20 to 80 MB. PD3's 20 MB limit is for student imports, not the library. */
export const LIBRARY_MAX_BYTES = 100 * 1024 * 1024;
const MAX_NAME_LENGTH = 120;

/** One path segment the library accepts: letters, digits, space, dot, dash, underscore; no leading dot. */
const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9 ._-]*$/;

export function isLibraryArea(value: unknown): value is LibraryArea {
	return typeof value === "string" && (LIBRARY_AREAS as readonly string[]).includes(value);
}

export function extensionOf(name: string): string {
	const dot = name.lastIndexOf(".");
	return dot <= 0 ? "" : name.slice(dot).toLowerCase();
}

export function isAllowedExtension(name: string): boolean {
	return (LIBRARY_EXTENSIONS as readonly string[]).includes(extensionOf(name));
}

/**
 * A safe library file name from what the browser sent, or null. Any folder
 * part is dropped, other characters become dashes, and the extension must be
 * one the tutor reads.
 */
export function cleanFileName(raw: unknown): string | null {
	if (typeof raw !== "string") return null;
	const base = raw.normalize("NFC").split(/[\\/]/).pop() ?? "";
	let name = base
		.replace(/[^A-Za-z0-9 ._-]+/g, "-")
		.replace(/-{2,}/g, "-")
		.replace(/\s{2,}/g, " ")
		.replace(/^[\s.-]+/, "")
		.trim();
	const ext = extensionOf(name);
	if (!(LIBRARY_EXTENSIONS as readonly string[]).includes(ext)) return null;
	let stem = name.slice(0, name.length - ext.length).replace(/[\s.-]+$/, "");
	if (!stem) return null;
	if (stem.length + ext.length > MAX_NAME_LENGTH) stem = stem.slice(0, MAX_NAME_LENGTH - ext.length).replace(/[\s.-]+$/, "");
	name = `${stem}${ext}`;
	return SAFE_SEGMENT.test(name) ? name : null;
}

/** A POH aircraft folder name: lowercase letters, digits and dashes, for example "c172s". */
export function cleanAircraft(raw: unknown): string | null {
	if (typeof raw !== "string") return null;
	const value = raw.trim().toLowerCase().replace(/\s+/g, "-");
	return /^[a-z0-9][a-z0-9-]{0,39}$/.test(value) ? value : null;
}

/** The folder (relative to the library) a file goes into, or an error in plain words. */
export function targetFolder(area: unknown, aircraft: unknown): { ok: true; folder: string } | { ok: false; error: string } {
	if (!isLibraryArea(area)) return { ok: false, error: "Choose FAA, NTSB, POH or North Aero." };
	if (area !== "poh") return { ok: true, folder: area };
	const plane = cleanAircraft(aircraft);
	if (!plane) return { ok: false, error: "Type the aircraft folder name, for example c172s (letters, digits and dashes)." };
	return { ok: true, folder: `poh/${plane}` };
}

/**
 * Check a library path the dashboard sent back (for remove): forward
 * slashes, an area first, safe segments only, an allowed extension. Returns
 * the cleaned relative path or null.
 */
export function checkRelativePath(raw: unknown): string | null {
	if (typeof raw !== "string" || raw.length > 400) return null;
	const parts = raw.split("/");
	if (parts.length < 2 || parts.length > 5) return null;
	if (!isLibraryArea(parts[0])) return null;
	if (!parts.every((p) => p !== "." && p !== ".." && SAFE_SEGMENT.test(p))) return null;
	if (!isAllowedExtension(parts[parts.length - 1] ?? "")) return null;
	return parts.join("/");
}

/**
 * The first bytes must match the type the name claims: %PDF- for PDF, the
 * usual signatures for images, and no NUL byte for text. Stops a renamed
 * file from landing in the library.
 */
export function contentMatchesName(name: string, head: Uint8Array): boolean {
	const ext = extensionOf(name);
	const starts = (...bytes: number[]) => bytes.every((b, i) => head[i] === b);
	switch (ext) {
		case ".pdf":
			return starts(0x25, 0x50, 0x44, 0x46, 0x2d);
		case ".png":
			return starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
		case ".jpg":
		case ".jpeg":
			return starts(0xff, 0xd8, 0xff);
		case ".gif":
			return starts(0x47, 0x49, 0x46, 0x38);
		case ".webp":
			return starts(0x52, 0x49, 0x46, 0x46) && head[8] === 0x57 && head[9] === 0x45 && head[10] === 0x42 && head[11] === 0x50;
		case ".md":
		case ".txt":
		case ".csv":
			return !head.includes(0);
		default:
			return false;
	}
}
