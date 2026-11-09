/**
 * North Aero C4 acceptance tests: every tenant reads the same library, and
 * no student request can write, rename or delete a library file. Uses the
 * sample files in tests/fixtures/frontdoor-library until T1 to T4 land.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import type { ChatStore, JobStore } from "../src/core/ports.ts";
import { assertNoProtected, buildVolume, LIBRARY_MARKERS, tenantEnv, type Volume } from "./fixtures/frontdoor-lockdown/volume.ts";

const repo = path.join(import.meta.dirname, "..");
const v: Volume = await buildVolume("lh-c4-library-");
const L = v.library;
const prior = Object.fromEntries(["HOME", "USERPROFILE", "LH_AUTH_FILE", "LH_DATA_DIR", "LH_LIBRARY_DIR"].map((key) => [key, process.env[key]]));
Object.assign(process.env, tenantEnv(v, "A"));
after(async () => {
	for (const [key, value] of Object.entries(prior)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
	await fs.rm(v.root, { recursive: true, force: true });
});

type Outcome = { ok: boolean; text: string };
interface TenantReport { dataDir: string; faa: Outcome; ntsb: Outcome; poh: Outcome; northAero: Outcome; roots: Outcome; search: Outcome; otherTenant: Outcome }

/** Start one tenant's process with the env the front door gives it. */
function runTenant(id: "A" | "B"): Promise<{ report: TenantReport; raw: string }> {
	const other = v.tenants[id === "A" ? "B" : "A"].privateFile;
	const script = path.join(repo, "tests", "fixtures", "frontdoor-lockdown", "tenant-read.ts");
	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, ["--import", "tsx", script, other], {
			cwd: repo,
			env: { PATH: process.env.PATH ?? "", NODE_ENV: "test", ...tenantEnv(v, id) },
			stdio: ["ignore", "pipe", "pipe"],
		});
		let out = "";
		let err = "";
		child.stdout.on("data", (chunk: Buffer) => { out += chunk.toString(); });
		child.stderr.on("data", (chunk: Buffer) => { err += chunk.toString(); });
		child.on("error", reject);
		child.on("close", (code) => {
			const line = out.split("\n").find((l) => l.startsWith("REPORT:"));
			if (code !== 0 || !line) return reject(new Error(`tenant ${id} exited ${code}: ${err.slice(-2000)}`));
			resolve({ report: JSON.parse(line.slice("REPORT:".length)) as TenantReport, raw: out + err });
		});
	});
}

/** Every entry under the library, without following links: type, link
 *  target, size, mode, mtime and a hash of each file's bytes. */
async function snapshot(root: string): Promise<Record<string, string>> {
	const out: Record<string, string> = {};
	async function walk(dir: string): Promise<void> {
		for (const entry of (await fs.readdir(dir)).sort()) {
			const full = path.join(dir, entry);
			const rel = path.relative(root, full);
			const stat = await fs.lstat(full);
			if (stat.isSymbolicLink()) out[rel] = `link -> ${await fs.readlink(full)}`;
			else if (stat.isDirectory()) { out[rel] = `dir ${stat.mode}`; await walk(full); }
			else out[rel] = `file ${stat.size} ${stat.mode} ${stat.mtimeMs} ${createHash("sha256").update(await fs.readFile(full)).digest("hex")}`;
		}
	}
	await walk(root);
	return out;
}

describe("C4 acceptance: the library", () => {
	it("an agent in each tenant can read a file in every library subfolder", async () => {
		const tenants = await Promise.all([runTenant("A"), runTenant("B")]);
		for (const [i, { report, raw }] of tenants.entries()) {
			const id = i === 0 ? "A" : "B";
			assert.equal(report.dataDir, v.tenants[id].dir);
			assert.ok(report.faa.ok && report.faa.text.includes(LIBRARY_MARKERS.faa), `tenant ${id} faa/: ${report.faa.text}`);
			assert.ok(report.ntsb.ok && report.ntsb.text.includes(LIBRARY_MARKERS.ntsb), `tenant ${id} ntsb/: ${report.ntsb.text}`);
			assert.ok(report.poh.ok && report.poh.text.includes(LIBRARY_MARKERS.poh), `tenant ${id} poh/C172S/: ${report.poh.text}`);
			assert.ok(report.northAero.ok && report.northAero.text.includes(LIBRARY_MARKERS.northAero), `tenant ${id} north-aero/: ${report.northAero.text}`);
			assert.equal(report.roots.text, `Allowed folders:\n${L}`);
			for (const marker of Object.values(LIBRARY_MARKERS)) assert.match(report.search.text, new RegExp(marker));
			assert.equal(report.otherTenant.ok, false);
			assert.match(report.otherTenant.text, /Access denied: .*allowed folders/);
			assertNoProtected(raw, `tenant ${id} process output`);
		}
	});

	it("the library sits outside every tenant folder, and no tenant folder sits inside it", () => {
		for (const tenant of Object.values(v.tenants)) {
			const rel = path.relative(tenant.dir, L);
			assert.ok(rel.startsWith(".."), `${L} is inside ${tenant.dir}`);
			assert.ok(path.relative(L, tenant.dir).startsWith(".."), `${tenant.dir} is inside the library`);
		}
	});

	it("no agent tool can write, rename or delete a file", async () => {
		const { createProberTools, createTeacherTools } = await import("../src/agent/tools.ts");
		const { practiceTools } = await import("../src/agent/tools/practice.ts");
		const { createPdfReadTools } = await import("../src/agent/tools/pdf-read.ts");
		const ctx = {
			chatId: "c4-synthetic",
			chatStore: { getChat: () => null, saveImageSnapshot: () => {} } as unknown as ChatStore,
			jobStore: { findJobByToolCallId: () => undefined, createJob: () => { throw new Error("no jobs here"); } } as unknown as JobStore,
			spawn: () => {},
			deliver: () => {},
		};
		const names = new Set([
			...Object.keys(createProberTools(ctx)),
			...Object.keys(createTeacherTools(ctx)),
			...Object.keys(practiceTools({ ...ctx, jobs: ctx })),
			...Object.keys(createPdfReadTools(v.root)),
		]);
		assert.ok(names.has("read") && names.has("ls"), `tool list looks wrong: ${[...names].join(", ")}`);
		const mutating = /(^|_)(write|edit|patch|delete|remove|rm|rename|move|mv|copy|cp|mkdir|touch|chmod|chown|upload|bash|shell|exec|run|spawn)($|_)/i;
		const offenders = [...names].filter((name) => mutating.test(name));
		assert.deepEqual(offenders, [], `agent tools that could change files: ${offenders.join(", ")}`);
	});

	it("every route that writes, renames or deletes leaves the library unchanged", async () => {
		const before = await snapshot(L);
		const chatRoute = await import("../app/api/chats/[id]/route.ts");
		const nodeRoute = await import("../app/api/graph/nodes/[id]/route.ts");
		const sourcesRoute = await import("../app/api/graph/sources/route.ts");
		const promptRoute = await import("../app/api/settings/prompts/[...segment]/route.ts");
		const importRoute = await import("../app/api/graph/import/route.ts");

		const target = v.files.faa;
		const ids = [
			"../../../library/faa/far-91-103-sample",
			"../../../library/faa/far-91-103-sample.md",
			"../../../library",
			target,
			"..%2F..%2F..%2Flibrary%2Ffaa%2Ffar-91-103-sample",
			"%2e%2e/%2e%2e/%2e%2e/library/faa/far-91-103-sample.md",
			"faa/far-91-103-sample.md",
		];
		const segments = [
			["..", "..", "..", "library", "faa", "far-91-103-sample.md"],
			["teacher", "..", "..", "..", "..", "library", "faa", "far-91-103-sample.md"],
			[target],
			["%2e%2e", "%2e%2e", "%2e%2e", "library", "faa", "far-91-103-sample.md"],
			["..%2F..%2F..%2Flibrary%2Ffaa%2Ffar-91-103-sample.md"],
		];
		const json = (method: string, url: string, body: unknown) => new Request(url, { method, body: JSON.stringify(body), headers: { "Content-Type": "application/json" } });
		const statuses: Array<[string, number]> = [];
		const call = async (label: string, fn: () => Promise<Response>) => {
			let status: number;
			try { status = (await fn()).status; } catch { status = 599; } // a thrown handler is a refusal too
			statuses.push([label, status]);
		};

		for (const id of ids) {
			const params = { params: Promise.resolve({ id }) };
			await call(`rename chat ${id}`, () => chatRoute.PUT(json("PUT", "http://localhost/api/chats/x", { title: "renamed" }), params));
			for (const mode of ["delete-nodes", "preserve-graph"]) {
				await call(`delete chat ${id} (${mode})`, () => chatRoute.DELETE(new Request(`http://localhost/api/chats/x?mode=${mode}`, { method: "DELETE" }), params));
			}
			await call(`delete node ${id}`, () => nodeRoute.DELETE(new Request("http://localhost/api/graph/nodes/x", { method: "DELETE" }), params));
			for (const body of [{ ids: [id] }, { sourceIds: [id] }, { kind: "delete", ids: [id] }, { kind: "move", ids: [id], folder: id }, { kind: "rename", id, name: "renamed" }]) {
				await call(`delete sources ${JSON.stringify(body)}`, () => sourcesRoute.DELETE(json("DELETE", "http://localhost/api/graph/sources", body)));
				await call(`change sources ${JSON.stringify(body)}`, () => sourcesRoute.POST(json("POST", "http://localhost/api/graph/sources", body)));
			}
		}
		for (const segment of segments) {
			const params = { params: Promise.resolve({ segment }) };
			await call(`write prompt ${segment.join("/")}`, () => promptRoute.PUT(json("PUT", "http://localhost/api/settings/prompts/x", { text: "overwritten" }), params));
			await call(`delete prompt ${segment.join("/")}`, () => promptRoute.DELETE(new Request("http://localhost/api/settings/prompts/x", { method: "DELETE" }), params));
		}
		for (const supplied of ["../../library/faa/far-91-103-sample.md", "../far-91-103-sample.md", target]) {
			const form = new FormData();
			form.append("files", new File(["overwritten"], "far-91-103-sample.md"));
			form.append("paths", supplied);
			await call(`import as ${supplied}`, () => importRoute.POST(new Request("http://localhost/api/graph/import", { method: "POST", body: form })));
		}

		for (const [label, status] of statuses) assert.ok(status >= 400, `${label} answered ${status}`);
		assert.deepEqual(await snapshot(L), before, "the library changed");
		assert.ok(Object.keys(before).length >= 10, "snapshot saw the library");
	});
});
