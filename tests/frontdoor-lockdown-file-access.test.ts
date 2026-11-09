/**
 * North Aero C5 acceptance tests: agent file tools are locked to the
 * library. One test process is one tenant (A); tenant B's folder, the
 * server user's home, the auth file and every .env file are the targets.
 *
 * The lock has two layers (Owner decision, 2026-11-08):
 *  - the Owner's settings template (frontdoor/settings-template) writes
 *    restricted mode with the library as the only folder, and
 *  - LH_LIBRARY_DIR, set by the front door, fixes the same rule in code,
 *    so a changed, missing or broken settings.json cannot widen it.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { after, afterEach, describe, it } from "node:test";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { ChatStore, JobStore } from "../src/core/ports.ts";
import { assertNoProtected, buildVolume, LIBRARY_MARKERS, PROTECTED_MARKERS, tenantEnv } from "./fixtures/frontdoor-lockdown/volume.ts";

const v = await buildVolume("lh-c5-lockdown-");
const { A, B } = v.tenants;
const L = v.library;
const prior = Object.fromEntries(["HOME", "USERPROFILE", "LH_AUTH_FILE", "LH_DATA_DIR", "LH_LIBRARY_DIR"].map((key) => [key, process.env[key]]));
Object.assign(process.env, tenantEnv(v, "A"));

const template = await import("../frontdoor/settings-template/file-access.ts");
const { CURRENT_SETTINGS_VERSION } = await import("../src/core/settings.ts");
const { readFileAccessSettings } = await import("../src/store/settings.ts");
// Importing a route loads the server barrel, whose chat-handler wires the
// server's File access policy into every agent tool, as in production.
const { PUT } = await import("../app/api/settings/[section]/route.ts");
const serverPolicy = await import("../src/server/file-access.ts");
const agentPolicy = await import("../src/agent/tools/file-access.ts");
const { resolveSourcePath } = await import("../src/agent/tools/fs-shared.ts");
const { readTool } = await import("../src/agent/tools/read.ts");
const { lsTool } = await import("../src/agent/tools/ls.ts");
const { findTool } = await import("../src/agent/tools/find.ts");
const { grepTool } = await import("../src/agent/tools/grep.ts");
const { createProberTools, createTeacherTools } = await import("../src/agent/tools.ts");
const { practiceTools } = await import("../src/agent/tools/practice.ts");

const templateText = await fs.readFile(A.settings, "utf8");
afterEach(async () => {
	await fs.writeFile(A.settings, templateText);
	process.env.LH_LIBRARY_DIR = L;
});
after(async () => {
	for (const [key, value] of Object.entries(prior)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
	await fs.rm(v.root, { recursive: true, force: true });
});

const boundary = /Access denied: .*allowed folders/;
const mandatory = /Access denied: .*protected location/;

type Outcome = { ok: boolean; text: string };
async function run(tool: AgentTool<any>, input: unknown): Promise<Outcome> {
	try {
		const result = await tool.execute!("c5", input);
		return { ok: true, text: result.content.map((part) => (part.type === "text" ? part.text : `[${part.type}]`)).join("\n") };
	} catch (error) {
		return { ok: false, text: error instanceof Error ? error.message : String(error) };
	}
}
async function readText(file: string): Promise<string> {
	const outcome = await run(readTool, { path: file });
	assert.ok(outcome.ok, `read ${file} failed: ${outcome.text}`);
	return outcome.text;
}
const put = (section: string, value: unknown) => PUT(
	new Request(`http://localhost/api/settings/${section}`, { method: "PUT", body: JSON.stringify(value), headers: { "Content-Type": "application/json" } }),
	{ params: Promise.resolve({ section }) },
);

const ctx = {
	chatId: "c5-synthetic",
	chatStore: { getChat: () => null, saveImageSnapshot: () => { throw new Error("must not snapshot a refused image"); } } as unknown as ChatStore,
	jobStore: { findJobByToolCallId: () => undefined, createJob: () => { throw new Error("must not create a refused job"); } } as unknown as JobStore,
	spawn: () => {},
	deliver: () => {},
};
const agentToolSets = { prober: createProberTools(ctx), teacher: createTeacherTools(ctx), practice: practiceTools({ ...ctx, jobs: ctx }) };

/** Every file-taking entry point an agent has, for one path. */
async function attempts(file: string): Promise<Record<string, Outcome>> {
	const out: Record<string, Outcome> = {
		read: await run(readTool, { path: file }),
		ls: await run(lsTool, { path: file }),
		find: await run(findTool, { path: file, pattern: "*" }),
		grep: await run(grepTool, { path: file, pattern: "." }),
	};
	for (const [name, tools] of Object.entries(agentToolSets)) {
		out[`${name}.read`] = await run(tools.read!, { path: file });
		if (tools.pdf) out[`${name}.pdf`] = await run(tools.pdf, { path: file, question: "?" });
		if (tools.show_image) out[`${name}.show_image`] = await run(tools.show_image, { path: file });
	}
	return out;
}

describe("C5 lock: configuration", () => {
	it("the Owner template is valid upstream File access: restricted, with the library as the only folder", () => {
		assert.deepEqual(template.LIBRARY_SUBFOLDERS, ["faa", "ntsb", "poh", "north-aero"]);
		assert.equal(template.libraryDir(v.volume), L);
		assert.deepEqual(template.fileAccessTemplate(L), { restricted: true, folders: [L] });
		assert.deepEqual(template.tenantLockdownEnv(L), { LH_LIBRARY_DIR: L });
		assert.throws(() => template.fileAccessTemplate("library"), /absolute/);
		assert.throws(() => template.libraryDir("volume"), /absolute/);

		const merged = template.applyFileAccessTemplate({
			version: 1,
			general: { autoUpdate: false },
			agent: { tools: { pdf: false }, fileAccess: { restricted: false, folders: ["~"] } },
		}, L);
		assert.deepEqual(merged, {
			version: 1,
			general: { autoUpdate: false },
			agent: { tools: { pdf: false }, fileAccess: { restricted: true, folders: [L] } },
		});
		assert.equal(template.applyFileAccessTemplate(null, L).version, CURRENT_SETTINGS_VERSION);
		assert.equal(template.applyFileAccessTemplate([], L).version, CURRENT_SETTINGS_VERSION);

		// The tenant's settings.json (written by the template) passes upstream's strict parser.
		assert.deepEqual(readFileAccessSettings(), { ok: true, settings: { restricted: true, folders: [L] } });
	});

	it("the server wires the library lock into every agent file tool", () => {
		assert.deepEqual(serverPolicy.fileAccessPolicy(), { restricted: true, folders: [L] });
		assert.deepEqual(agentPolicy.fileAccessPolicy(), { restricted: true, folders: [L] });
	});

	it("a student's settings change cannot widen File access", async () => {
		// The route still accepts the write (the front door blocks it in P2-03)...
		const open = await put("agent", { fileAccess: { restricted: false, folders: [] } });
		assert.equal(open.status, 200);
		const stored = readFileAccessSettings();
		assert.ok(stored.ok && stored.settings.restricted === false, "the student's change reached settings.json");
		// ...but the agent's tools stay locked to the library.
		assert.match((await run(readTool, { path: "/etc/passwd" })).text, boundary);
		assert.match((await run(readTool, { path: B.privateFile })).text, boundary);
		assert.match(await readText(v.files.faa), new RegExp(LIBRARY_MARKERS.faa));

		const wide = await put("agent", { fileAccess: { restricted: true, folders: [v.root, "~"] } });
		assert.equal(wide.status, 200);
		assert.match((await run(readTool, { path: B.privateFile })).text, boundary);
		assert.match((await run(readTool, { path: `${v.home}/notes.md` })).text, boundary);
		assert.deepEqual(agentPolicy.fileAccessPolicy(), { restricted: true, folders: [L] });
	});

	it("a missing or broken settings file still leaves the library as the only folder", async () => {
		for (const state of ["missing", "broken"] as const) {
			if (state === "missing") await fs.rm(A.settings);
			else await fs.writeFile(A.settings, "{ not json");
			assert.match((await run(readTool, { path: "/etc/passwd" })).text, boundary, state);
			assert.match((await run(readTool, { path: B.privateFile })).text, boundary, state);
			assert.match(await readText(v.files.ntsb), new RegExp(LIBRARY_MARKERS.ntsb), state);
		}
	});

	it("an empty or relative LH_LIBRARY_DIR blocks every read, even inside the library", async () => {
		for (const value of ["", "library", "./volume/library"]) {
			process.env.LH_LIBRARY_DIR = value;
			const outcome = await run(readTool, { path: v.files.faa });
			assert.equal(outcome.ok, false, `LH_LIBRARY_DIR=${JSON.stringify(value)} must fail closed`);
			assert.match(outcome.text, /LH_LIBRARY_DIR/);
			assert.match((await run(readTool, { path: "/etc/passwd" })).text, /LH_LIBRARY_DIR/);
		}
	});
});

describe("C5 acceptance: each attempt fails", () => {
	const named: Array<[string, string, RegExp]> = [
		["/etc/passwd", "/etc/passwd", boundary],
		["another tenant's folder", B.privateFile, boundary],
		["another tenant's folder, through ..", `${L}/../tenants/B/private/record.md`, boundary],
		["another tenant's folder, through a nested ..", `${L}/faa/../../tenants/B/private/record.md`, boundary],
		["~/.ssh", "~/.ssh/id_rsa", mandatory],
		["the file named by LH_AUTH_FILE", A.auth, mandatory],
		["a .env file in the library", `${L}/north-aero/.env`, mandatory],
		["a .env.local file in the library", `${L}/faa/.env.local`, mandatory],
		["a .env file in another tenant's folder", `${B.dir}/.env`, mandatory],
		["a .env file at the volume root", `${v.volume}/.env`, mandatory],
		["a file symlink that points out of the library", `${L}/faa/passwd.md`, boundary],
		["a folder symlink that points out of the library", `${L}/north-aero/tenant-b/private/record.md`, boundary],
		["a chain of symlinks that points out of the library", `${L}/ntsb/hop1/record.md`, boundary],
		["a symlink to the auth file", `${L}/poh/C172S/keys.json`, mandatory],
		["a symlink to ~/.ssh", `${L}/ssh/id_rsa`, mandatory],
	];
	for (const [label, file, expected] of named) {
		it(`${label} fails`, async () => {
			assert.throws(() => resolveSourcePath(file), expected);
			for (const [entry, outcome] of Object.entries(await attempts(file))) {
				assert.equal(outcome.ok, false, `${entry} must refuse ${file}`);
				assert.match(outcome.text, expected, `${entry} on ${file}`);
				assertNoProtected(outcome.text, `${entry} on ${file}`);
			}
		});
	}

	it("a read inside the library succeeds", async () => {
		assert.match(await readText(v.files.faa), new RegExp(LIBRARY_MARKERS.faa));
		assert.match(await readText(v.files.ntsb), new RegExp(LIBRARY_MARKERS.ntsb));
		assert.match(await readText(v.files.poh), new RegExp(LIBRARY_MARKERS.poh));
		assert.match(await readText(v.files.northAero), new RegExp(LIBRARY_MARKERS.northAero));
		assert.equal((await run(lsTool, {})).text, `Allowed folders:\n${L}`);
	});

	it("listings and searches show library files only, never what a link or .env holds", async () => {
		const top = await run(lsTool, { path: L });
		assert.ok(top.ok, top.text);
		for (const folder of ["faa/", "ntsb/", "poh/", "north-aero/"]) assert.match(top.text, new RegExp(`^${folder}$`, "m"));
		assert.doesNotMatch(top.text, /ssh|home-notes/);
		const northAero = await run(lsTool, { path: `${L}/north-aero` });
		assert.doesNotMatch(northAero.text, /tenant-b|\.env/);

		const found = await run(findTool, { pattern: "*" });
		assert.ok(found.ok, found.text);
		const files = found.text.split("\n").filter((line) => line.startsWith("/"));
		assert.deepEqual(new Set(files), new Set(Object.values(v.files)));

		for (const marker of Object.values(PROTECTED_MARKERS)) {
			const searched = await run(grepTool, { pattern: marker });
			assert.equal(searched.text, "No matches found", `grep ${marker}`);
		}
		const hits = await run(grepTool, { pattern: "LIBRARY_[A-Z_]+MARKER" });
		for (const marker of Object.values(LIBRARY_MARKERS)) assert.match(hits.text, new RegExp(marker));
	});
});

describe("C5 acceptance: path-traversal spellings", () => {
	const passwd = "../".repeat(16) + "etc/passwd";
	/** Each spelling names something outside the library: the guard must refuse it. */
	const escapes = [
		"/etc/passwd", "/etc//passwd", "/etc/./passwd", "//etc/passwd", "/./etc/passwd", "/etc/../etc/passwd", "/etc/passwd/",
		"/proc/self/environ", "/", "/tmp",
		`${L}/${passwd}`, `${L}/faa/${passwd}`, `${L}/poh/C172S/${passwd}`,
		`${L}/..`, `${L}/../..`, `${L}/../`, `${L}/./..`,
		`${L}/../tenants/B/private/record.md`,
		`${L}/faa/../../tenants/B/private/record.md`,
		`${L}/./../tenants/B/private/record.md`,
		`${L}//..//tenants//B//private//record.md`,
		`${L}/faa/./.././../tenants/B/private/record.md`,
		`${L}/faa/far-91-103-sample.md/../../../tenants/B/private/record.md`,
		`${L}/../library/../tenants/B/private/record.md`,
		`${L}/../tenants/B/`, `${L}/../tenants/B`, `${L}/../tenants`,
		`${L}/../tenants/A/auth.json`, `${L}/../tenants/A/private/record.md`, `${L}/../tenants/A/settings.json`,
		`${L}/../tenants/B/.env`, `${L}/../.env`,
		`${L}/../library-old/secret.md`, `${L}-old/secret.md`,
		`${L}/../../home/.ssh/id_rsa`, `${L}/../../home/notes.md`,
		B.privateFile, B.dir, `${B.dir}/private/../private/record.md`, B.auth, A.auth, A.dir, A.settings,
		"~", "~/notes.md", "~/.ssh/id_rsa", "~//.ssh/id_rsa", "~/./.ssh/id_rsa", "~/.SSH/id_rsa", "~/.ssh/../.ssh/id_rsa",
		"~/../../etc/passwd", "~/../volume/tenants/B/private/record.md", "~/../volume/library/../tenants/B/private/record.md",
		".", "..", "./../volume/tenants/A/auth.json", "../volume/tenants/B/private/record.md",
		"../volume/library/../tenants/B/private/record.md", passwd, "etc/passwd", ".ssh/id_rsa", "notes.md",
		`file://${B.privateFile}`,
		`${L}/north-aero/tenant-b`, `${L}/north-aero/tenant-b/`, `${L}/north-aero/tenant-b/private/record.md`,
		`${L}/north-aero/./tenant-b/private/record.md`, `${L}/north-aero/tenant-b/../tenant-b/private/record.md`,
		`${L}/ntsb/hop1/record.md`, `${L}/ntsb/hop2/record.md`, `${L}/ntsb/hop1`,
		`${L}/faa/passwd.md`, `${L}/ssh/id_rsa`, `${L}/ssh`, `${L}/home-notes.md`, `${L}/poh/C172S/keys.json`,
		`${L}/north-aero/.env`, `${L}/faa/.env.local`, `${L}/faa/.ENV`, `${L}/faa/.Env.production`, `${B.dir}/.env`, `${v.volume}/.env`,
		`${v.files.faa}\u0000/../../../tenants/B/private/record.md`,
	];
	/** Spellings that stay inside the library as literal names. Nothing
	 *  exists there, so the read fails and nothing protected comes back. */
	const literalInside = [
		`${L}/%2e%2e/tenants/B/private/record.md`,
		`${L}/%2e%2e%2ftenants%2fB%2fprivate%2frecord.md`,
		`${L}/..%2f..%2ftenants/B/private/record.md`,
		`${L}/faa\\..\\..\\tenants\\B\\private\\record.md`,
		`${L}/‥/tenants/B/private/record.md`,
		`${L}/．．/tenants/B/private/record.md`,
		`${L}/....//tenants/B/private/record.md`,
		`${L}/.../tenants/B/private/record.md`,
		`${L}/faa/..../..../tenants/B/private/record.md`,
	];

	it(`${escapes.length} spellings that leave the library are all refused`, async () => {
		for (const file of escapes) {
			assert.throws(() => resolveSourcePath(file), Error, `guard must refuse ${JSON.stringify(file)}`);
			for (const [entry, outcome] of Object.entries(await attempts(file))) {
				assert.equal(outcome.ok, false, `${entry} must refuse ${JSON.stringify(file)}`);
				assertNoProtected(outcome.text, `${entry} on ${JSON.stringify(file)}`);
			}
		}
	});

	it(`${literalInside.length} literal look-alike spellings read nothing`, async () => {
		for (const file of literalInside) {
			const outcomes = await attempts(file);
			assert.equal(outcomes.read!.ok, false, `read must fail for ${JSON.stringify(file)}`);
			for (const [entry, outcome] of Object.entries(outcomes)) assertNoProtected(outcome.text, `${entry} on ${JSON.stringify(file)}`);
		}
	});
});
