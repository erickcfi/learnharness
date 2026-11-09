/**
 * P5-01: the library folder and the Owner's upload page (C4 req 1 to 3,
 * PD6). The Owner adds, replaces and removes library files from the
 * dashboard; files land in <volume>/library/<area>/ and every tenant's
 * tutor can read them with its own file tools (lockdown keeps those tools
 * read-only and inside the library).
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import { request } from "node:http";
import * as path from "node:path";
import { Readable } from "node:stream";
import { after, before, describe, it } from "node:test";
import { cleanAircraft, cleanFileName, LibraryError, listLibrary, removeLibraryFile, saveLibraryFile } from "../frontdoor/library/index.ts";
import { type Fixture, startFixture } from "./frontdoor-admin-fixture.ts";

const REPO = path.join(import.meta.dirname, "..");
const PDF = Buffer.concat([Buffer.from("%PDF-1.7\n"), Buffer.alloc(2000, 0x41), Buffer.from("\n%%EOF\n")]);
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);

let f: Fixture;
let owner: string;

before(async () => {
	f = await startFixture();
	owner = await f.cookie(f.owner.clerkUserId);
});
after(async () => {
	await f.close();
});

function upload(query: string, body: Buffer | string, cookie = owner): Promise<Response> {
	return fetch(`${f.base}/admin/api/library?${query}`, {
		method: "PUT",
		headers: { Cookie: cookie, ...f.origin(), "Content-Type": "application/octet-stream" },
		body: typeof body === "string" ? body : new Uint8Array(body),
	});
}
const incomingLeft = () => {
	const dir = path.join(f.volume, ".library-incoming");
	return fs.existsSync(dir) ? fs.readdirSync(dir) : [];
};

describe("file names and folders", () => {
	it("keep only safe names with a type the tutor reads", () => {
		assert.equal(cleanFileName("Pilot's Handbook (PHAK) 2023.pdf"), "Pilot-s Handbook -PHAK- 2023.pdf");
		assert.equal(cleanFileName("../../etc/passwd.pdf"), "passwd.pdf");
		assert.equal(cleanFileName("C:\\Users\\Erick\\AIM.PDF"), "AIM.pdf");
		assert.equal(cleanFileName(".hidden.md"), "hidden.md");
		for (const bad of ["virus.exe", "notes", "x.pdf.sh", "", ".pdf", 42]) assert.equal(cleanFileName(bad), null, String(bad));
		assert.equal(cleanAircraft("C172S"), "c172s");
		assert.equal(cleanAircraft("PA 28"), "pa-28");
		for (const bad of ["../x", "", "a/b", "-x"]) assert.equal(cleanAircraft(bad), null, bad);
	});
});

describe("uploads land in the library", () => {
	it("in the chosen area, byte for byte", async () => {
		const res = await upload("area=faa&name=PHAK.pdf", PDF);
		assert.equal(res.status, 200);
		const body = (await res.json()) as { file: { relPath: string; bytes: number }; replaced: boolean };
		assert.equal(body.file.relPath, "faa/PHAK.pdf");
		assert.equal(body.replaced, false);
		assert.deepEqual(fs.readFileSync(path.join(f.libraryDir, "faa", "PHAK.pdf")), PDF);
		assert.deepEqual(incomingLeft(), []);
	});

	it("POH files go in a folder per aircraft", async () => {
		assert.equal((await upload("area=poh&name=perf.md", "# C172S takeoff")).status, 400, "the aircraft is required");
		const res = await upload("area=poh&aircraft=C172S&name=perf.md", "# C172S takeoff distance\nGround roll 960 ft at sea level.\n");
		assert.equal(res.status, 200);
		assert.ok(fs.existsSync(path.join(f.libraryDir, "poh", "c172s", "perf.md")));
		assert.equal((await upload("area=north-aero&name=syllabus.txt", "Stage 1")).status, 200);
		assert.equal((await upload("area=ntsb&name=chart.png", PNG)).status, 200);
	});

	it("a file of the same name is replaced only when the Owner confirms", async () => {
		const again = await upload("area=north-aero&name=syllabus.txt", "Stage 1, revised");
		assert.equal(again.status, 409);
		assert.equal(fs.readFileSync(path.join(f.libraryDir, "north-aero", "syllabus.txt"), "utf8"), "Stage 1");
		const replaced = await upload("area=north-aero&name=syllabus.txt&replace=1", "Stage 1, revised");
		assert.equal(replaced.status, 200);
		assert.equal(((await replaced.json()) as { replaced: boolean }).replaced, true);
		assert.equal(fs.readFileSync(path.join(f.libraryDir, "north-aero", "syllabus.txt"), "utf8"), "Stage 1, revised");
	});

	it("refuses other types, renamed files, empty files and unknown areas, leaving nothing behind", async () => {
		assert.equal((await upload("area=faa&name=tool.exe", "MZ")).status, 400);
		assert.equal((await upload("area=faa&name=fake.pdf", "MZ this is not a pdf")).status, 400);
		assert.equal((await upload("area=faa&name=bin.txt", Buffer.from([0x41, 0, 0x42]))).status, 400);
		assert.equal((await upload("area=faa&name=empty.md", "")).status, 400);
		assert.equal((await upload("area=tenants&name=x.md", "x")).status, 400);
		assert.equal((await upload("area=..&name=x.md", "x")).status, 400);
		assert.ok(!fs.existsSync(path.join(f.libraryDir, "faa", "fake.pdf")));
		assert.deepEqual(incomingLeft(), []);
	});

	it("refuses a file over the size limit before reading it", async () => {
		const status = await new Promise<number>((resolve, reject) => {
			const url = new URL(`${f.base}/admin/api/library?area=faa&name=huge.pdf`);
			const req = request(
				{ host: url.hostname, port: url.port, path: `${url.pathname}${url.search}`, method: "PUT", headers: { Cookie: owner, Origin: f.base, "Content-Length": String(200 * 1024 * 1024) } },
				(res) => {
					res.resume();
					resolve(res.statusCode ?? 0);
					req.destroy();
				},
			);
			req.on("error", (e) => (String(e).includes("socket hang up") ? undefined : reject(e)));
			req.write("%PDF-");
		});
		assert.equal(status, 413);
	});

	it("stops a stream that runs past the limit, and removes the part file", async () => {
		const big = Readable.from([Buffer.from("%PDF-1.7\n"), Buffer.alloc(600), Buffer.alloc(600)]);
		await assert.rejects(saveLibraryFile(f.libraryDir, big, { area: "faa", fileName: "big.pdf", maxBytes: 1000 }), (e: unknown) => e instanceof LibraryError && e.code === "too-large");
		assert.ok(!fs.existsSync(path.join(f.libraryDir, "faa", "big.pdf")));
		assert.deepEqual(incomingLeft(), []);
	});

	it("never writes through a link", async () => {
		const outside = path.join(f.volume, "outside");
		fs.mkdirSync(outside);
		fs.symlinkSync(outside, path.join(f.libraryDir, "poh", "linked"));
		assert.equal((await upload("area=poh&aircraft=linked&name=x.md", "x")).status, 400);
		assert.deepEqual(fs.readdirSync(outside), []);
		fs.symlinkSync(path.join(outside, "target.md"), path.join(f.libraryDir, "faa", "link.md"));
		assert.equal((await upload("area=faa&name=link.md&replace=1", "x")).status, 400);
		assert.ok(!fs.existsSync(path.join(outside, "target.md")));
	});

	it("lists what is there", async () => {
		const res = await fetch(`${f.base}/admin/api/library`, { headers: { Cookie: owner } });
		const files = (await res.json()) as Array<{ relPath: string }>;
		assert.deepEqual(
			files.map((x) => x.relPath),
			["faa/PHAK.pdf", "north-aero/syllabus.txt", "ntsb/chart.png", "poh/c172s/perf.md"],
		);
		assert.deepEqual((await listLibrary(f.libraryDir)).map((x) => x.relPath), files.map((x) => x.relPath));
	});
});

describe("uploaded files are readable by a tenant's tutor", () => {
	it("through the agent's own read tool, with the front door's lockdown env", async () => {
		const tenantDir = path.join(f.volume, "tenants", "11111111-1111-4111-8111-111111111111");
		const home = path.join(f.volume, "home");
		fs.mkdirSync(tenantDir, { recursive: true });
		fs.mkdirSync(home, { recursive: true });
		const env: NodeJS.ProcessEnv = {
			PATH: process.env.PATH ?? "",
			NODE_ENV: "test",
			HOME: home,
			USERPROFILE: home,
			LH_DATA_DIR: tenantDir,
			LH_AUTH_FILE: path.join(f.volume, "auth.json"),
			LH_LIBRARY_DIR: f.libraryDir,
		};
		const script = path.join(REPO, "tests", "fixtures", "frontdoor-admin", "tenant-read-library.ts");
		const targets = [path.join(f.libraryDir, "poh", "c172s", "perf.md"), path.join(f.libraryDir, "north-aero", "syllabus.txt"), path.join(f.volume, "outside", "nope.md")];
		fs.writeFileSync(targets[2]!, "outside the library");
		const report = await new Promise<Array<{ ok: boolean; text: string }>>((resolve, reject) => {
			const child = spawn(process.execPath, ["--import", "tsx", script, ...targets], { cwd: REPO, env, stdio: ["ignore", "pipe", "pipe"] });
			let out = "";
			let err = "";
			child.stdout.on("data", (c: Buffer) => (out += c.toString()));
			child.stderr.on("data", (c: Buffer) => (err += c.toString()));
			child.on("error", reject);
			child.on("close", (code) => {
				const line = out.split("\n").find((l) => l.startsWith("REPORT:"));
				if (code !== 0 || !line) return reject(new Error(`tenant exited ${code}: ${err.slice(-1500)}`));
				resolve(JSON.parse(line.slice("REPORT:".length)) as Array<{ ok: boolean; text: string }>);
			});
		});
		assert.equal(report[0]?.ok, true, report[0]?.text);
		assert.match(report[0]?.text ?? "", /Ground roll 960 ft/);
		assert.equal(report[1]?.ok, true, report[1]?.text);
		assert.match(report[1]?.text ?? "", /Stage 1, revised/);
		assert.equal(report[2]?.ok, false, "a file outside the library stays unreadable");
	});
});

describe("removing a file", () => {
	const remove = (body: string) =>
		fetch(`${f.base}/admin/api/library/remove`, {
			method: "POST",
			redirect: "manual",
			headers: { Cookie: owner, "Content-Type": "application/x-www-form-urlencoded", ...f.origin() },
			body,
		});

	it("needs the confirm step", async () => {
		const res = await remove("path=ntsb%2Fchart.png&back=%2Fadmin%2Flibrary");
		assert.equal(res.status, 303);
		assert.match(res.headers.get("location") ?? "", /^\/admin\/library\?error=/);
		assert.ok(fs.existsSync(path.join(f.libraryDir, "ntsb", "chart.png")));
	});

	it("removes the file once confirmed", async () => {
		const res = await remove("path=ntsb%2Fchart.png&confirm=yes&back=%2Fadmin%2Flibrary");
		assert.equal(res.headers.get("location"), "/admin/library?done=file-removed");
		assert.ok(!fs.existsSync(path.join(f.libraryDir, "ntsb", "chart.png")));
	});

	it("refuses anything that is not a file inside the library", async () => {
		fs.writeFileSync(path.join(f.volume, "secret.md"), "keep me");
		for (const p of ["../secret.md", "faa/../../secret.md", "/etc/passwd", "faa", "poh/c172s", "faa/link.md", "tenants/x.md", "faa/nope.pdf"]) {
			const res = await remove(`path=${encodeURIComponent(p)}&confirm=yes`);
			assert.match(res.headers.get("location") ?? "", /error=/, p);
		}
		assert.equal(fs.readFileSync(path.join(f.volume, "secret.md"), "utf8"), "keep me");
		assert.ok(fs.existsSync(path.join(f.libraryDir, "poh", "c172s", "perf.md")));
		await assert.rejects(removeLibraryFile(f.libraryDir, "poh/linked/x.md"));
	});

	it("only the Owner can upload or remove", async () => {
		const s = await f.student("lib_student");
		const cookie = await f.cookie(s.clerkUserId, { tenantId: s.tenantId });
		assert.equal((await upload("area=faa&name=student.md", "x", cookie)).status, 403);
		const res = await fetch(`${f.base}/admin/api/library/remove`, {
			method: "POST",
			headers: { Cookie: cookie, "Content-Type": "application/x-www-form-urlencoded", ...f.origin() },
			body: "path=faa%2FPHAK.pdf&confirm=yes",
		});
		assert.equal(res.status, 403);
		assert.ok(fs.existsSync(path.join(f.libraryDir, "faa", "PHAK.pdf")));
		assert.ok(!fs.existsSync(path.join(f.libraryDir, "faa", "student.md")));
	});
});
