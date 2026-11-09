/**
 * The File access part of the Owner's settings template (PRD C5, C4).
 *
 * Each tenant's LearnHarness server runs upstream's restricted mode with
 * exactly one allowed folder: the shared library at <volume>/library/.
 * Two layers carry the rule (Owner decision, 2026-11-08):
 *
 *  1. applyFileAccessTemplate() writes it into the tenant's settings.json,
 *     so the Settings screen shows the real rule.
 *  2. tenantLockdownEnv() gives LH_LIBRARY_DIR, which the front door passes
 *     to the tenant's server. Upstream src/server/file-access.ts (fork edit)
 *     then fixes the same rule in code, so a changed, missing or broken
 *     settings.json cannot widen it.
 *
 * Framework-free and runnable by plain Node (type stripping): relative
 * imports only, with .ts extensions, and no TypeScript-only runtime syntax.
 */
import path from "node:path";

/** The library's layout (PRD C4 requirement 1). POH folders are per aircraft. */
export const LIBRARY_SUBFOLDERS = ["faa", "ntsb", "poh", "north-aero"] as const;

/** Upstream's settings.json schema version (CURRENT_SETTINGS_VERSION in
 *  src/core/settings.ts). A test pins the two together. */
const SETTINGS_VERSION = 1;

export interface FileAccessTemplate {
	restricted: true;
	folders: [string];
}

function absolute(value: string, what: string): string {
	if (typeof value !== "string" || !path.isAbsolute(value)) throw new Error(`${what} must be an absolute path`);
	return path.resolve(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** <volume>/library, from the Railway volume's mount path (for example /data). */
export function libraryDir(volume: string): string {
	return path.join(absolute(volume, "The volume path"), "library");
}

/** Restricted mode with the library as the only allowed folder. */
export function fileAccessTemplate(library: string): FileAccessTemplate {
	return { restricted: true, folders: [absolute(library, "The library path")] };
}

/** A copy of a tenant's settings record with agent.fileAccess set to the
 *  template. Any earlier fileAccess value is replaced; every other key is
 *  kept. A missing or malformed record starts from an empty one. */
export function applyFileAccessTemplate(settings: unknown, library: string): Record<string, unknown> {
	const record: Record<string, unknown> = isRecord(settings) ? { ...settings } : {};
	if (typeof record.version !== "number") record.version = SETTINGS_VERSION;
	const agent: Record<string, unknown> = isRecord(record.agent) ? { ...record.agent } : {};
	agent.fileAccess = fileAccessTemplate(library);
	record.agent = agent;
	return record;
}

/** The environment value the front door passes to every tenant server. */
export function tenantLockdownEnv(library: string): { LH_LIBRARY_DIR: string } {
	return { LH_LIBRARY_DIR: absolute(library, "The library path") };
}
