/**
 * A synthetic Railway volume for the North Aero lockdown tests (C4, C5):
 *
 *   <root>/home/                 the server user's home (.ssh, notes)
 *   <root>/volume/library/       faa/, ntsb/, poh/C172S/, north-aero/ (fixture samples)
 *   <root>/volume/tenants/A|B/   settings.json (Owner template), auth.json, private/
 *
 * Plus the traps C5 names: .env files, a sibling "library-old" folder, and
 * symlinks inside the library that point out of it. Every protected file
 * carries a marker; no test output may ever contain one.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { applyFileAccessTemplate, libraryDir } from "../../../frontdoor/settings-template/file-access.ts";

export const LIBRARY_MARKERS = {
	faa: "LIBRARY_FAA_MARKER",
	ntsb: "LIBRARY_NTSB_MARKER",
	poh: "LIBRARY_POH_MARKER",
	northAero: "LIBRARY_NORTH_AERO_MARKER",
} as const;

export const PROTECTED_MARKERS = {
	tenantA: "TENANT_A_RECORD_MARKER",
	tenantB: "TENANT_B_PRIVATE_MARKER",
	auth: "AUTH_FILE_MARKER",
	ssh: "SSH_KEY_MARKER",
	dotenv: "DOTENV_MARKER",
	home: "HOME_ONLY_MARKER",
	sibling: "SIBLING_FOLDER_MARKER",
	/** The first line of the real /etc/passwd on every Linux CI runner. */
	passwd: "root:x:0:0",
} as const;

export interface Tenant {
	dir: string;
	auth: string;
	settings: string;
	privateFile: string;
}

export interface Volume {
	root: string;
	home: string;
	volume: string;
	library: string;
	tenants: { A: Tenant; B: Tenant };
	files: { faa: string; ntsb: string; poh: string; northAero: string };
}

const FIXTURE = path.join(import.meta.dirname, "..", "frontdoor-library");

async function write(file: string, text: string): Promise<void> {
	await fs.mkdir(path.dirname(file), { recursive: true });
	await fs.writeFile(file, text);
}

async function link(target: string, alias: string): Promise<void> {
	await fs.mkdir(path.dirname(alias), { recursive: true });
	await fs.symlink(target, alias);
}

async function tenant(volume: string, library: string, id: "A" | "B", marker: string): Promise<Tenant> {
	const dir = path.join(volume, "tenants", id);
	const t: Tenant = {
		dir,
		auth: path.join(dir, "auth.json"),
		settings: path.join(dir, "settings.json"),
		privateFile: path.join(dir, "private", "record.md"),
	};
	await write(t.settings, JSON.stringify(applyFileAccessTemplate({ version: 1 }, library), null, "\t"));
	await write(t.auth, JSON.stringify({ SYNTHETIC_KEY: PROTECTED_MARKERS.auth }));
	await write(t.privateFile, `private study record ${marker}\n`);
	await write(path.join(dir, ".env"), `SYNTHETIC=${PROTECTED_MARKERS.dotenv}\n`);
	return t;
}

export async function buildVolume(prefix: string): Promise<Volume> {
	const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), prefix)));
	const home = path.join(root, "home");
	const volume = path.join(root, "volume");
	const library = libraryDir(volume);

	await fs.cp(FIXTURE, library, { recursive: true });
	const files = {
		faa: path.join(library, "faa", "far-91-103-sample.md"),
		ntsb: path.join(library, "ntsb", "sample-report.md"),
		poh: path.join(library, "poh", "C172S", "performance-sample.md"),
		northAero: path.join(library, "north-aero", "syllabus-sample.md"),
	};

	const tenants = {
		A: await tenant(volume, library, "A", PROTECTED_MARKERS.tenantA),
		B: await tenant(volume, library, "B", PROTECTED_MARKERS.tenantB),
	};

	await write(path.join(home, ".ssh", "id_rsa"), `${PROTECTED_MARKERS.ssh}\n`);
	await write(path.join(home, "notes.md"), `${PROTECTED_MARKERS.home}\n`);
	await write(path.join(volume, ".env"), `SYNTHETIC=${PROTECTED_MARKERS.dotenv}\n`);
	await write(path.join(volume, "library-old", "secret.md"), `${PROTECTED_MARKERS.sibling}\n`);
	await write(path.join(library, "north-aero", ".env"), `SYNTHETIC=${PROTECTED_MARKERS.dotenv}\n`);
	await write(path.join(library, "faa", ".env.local"), `SYNTHETIC=${PROTECTED_MARKERS.dotenv}\n`);

	// Symlinks inside the library that point out of it.
	await link(tenants.B.dir, path.join(library, "north-aero", "tenant-b"));
	await link("/etc/passwd", path.join(library, "faa", "passwd.md"));
	await link(tenants.A.auth, path.join(library, "poh", "C172S", "keys.json"));
	await link(path.join(home, ".ssh"), path.join(library, "ssh"));
	await link(path.join(home, "notes.md"), path.join(library, "home-notes.md"));
	await link(path.join(tenants.B.dir, "private"), path.join(library, "ntsb", "hop2"));
	await link(path.join(library, "ntsb", "hop2"), path.join(library, "ntsb", "hop1"));

	return { root, home, volume, library, tenants, files };
}

/** The environment one tenant's server gets from the front door. */
export function tenantEnv(v: Volume, id: "A" | "B"): Record<string, string> {
	return {
		HOME: v.home,
		USERPROFILE: v.home,
		LH_DATA_DIR: v.tenants[id].dir,
		LH_AUTH_FILE: v.tenants[id].auth,
		LH_LIBRARY_DIR: v.library,
	};
}

/** No protected marker may appear in any tool output or error text. */
export function assertNoProtected(text: string, context: string): void {
	for (const marker of Object.values(PROTECTED_MARKERS)) {
		if (text.includes(marker)) throw new Error(`${context}: output leaked protected content (${marker})`);
	}
}
