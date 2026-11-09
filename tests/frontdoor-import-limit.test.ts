/**
 * North Aero C5 requirement 3 and PD3: a student's import is limited to
 * 20 MB per file. Upstream's 25 MB per-upload limit stays as it is.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "lh-import-limit-"));
const prior = Object.fromEntries(["LH_DATA_DIR", "LH_AUTH_FILE"].map((key) => [key, process.env[key]]));
process.env.LH_DATA_DIR = path.join(root, "data");
process.env.LH_AUTH_FILE = path.join(root, "auth.json");
fs.writeFileSync(process.env.LH_AUTH_FILE, "{}");
const { POST } = await import("../app/api/graph/import/route.ts");
const { extraction } = await import("../src/server/index.ts");
const original = extraction.importNotes;
after(() => {
	extraction.importNotes = original;
	for (const [key, value] of Object.entries(prior)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
	fs.rmSync(root, { recursive: true, force: true });
});

const MB = 1024 * 1024;
function upload(files: Array<[string, number]>): Request {
	const form = new FormData();
	for (const [name, size] of files) form.append("files", new File([new Uint8Array(size).fill(0x61)], name));
	return new Request("http://localhost/api/graph/import", { method: "POST", body: form });
}

describe("import size limit (PD3)", () => {
	it("refuses a file over 20 MB before any model call", async () => {
		let calls = 0;
		extraction.importNotes = async () => { calls++; return { nodes: 0, chains: 0 }; };
		const response = await POST(upload([["big.md", 20 * MB + 1]]));
		assert.equal(response.status, 413);
		assert.equal(((await response.json()) as { error?: string }).error, "Too big. Max 20 MB per file.");
		assert.equal(calls, 0);
	});

	it("refuses the whole upload when one file is over 20 MB", async () => {
		let calls = 0;
		extraction.importNotes = async () => { calls++; return { nodes: 0, chains: 0 }; };
		const response = await POST(upload([["small.md", 1024], ["big.md", 20 * MB + 1]]));
		assert.equal(response.status, 413);
		assert.equal(calls, 0);
	});

	it("accepts a file of exactly 20 MB, and two files that are each under the limit", async () => {
		const imported: string[] = [];
		extraction.importNotes = async ({ filePath }) => { imported.push(filePath); return { nodes: 0, chains: 0 }; };
		const one = await POST(upload([["exact.md", 20 * MB]]));
		assert.equal(one.status, 200);
		const two = await POST(upload([["a.md", 12 * MB], ["b.md", 12 * MB]]));
		assert.equal(two.status, 200);
		assert.deepEqual(imported.sort(), ["a.md", "b.md", "exact.md"]);
	});
});
