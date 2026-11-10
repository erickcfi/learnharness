/**
 * The Owner's multi-file library upload (frontdoor/app/admin/library/upload-batch.ts):
 * files go one after another, an existing file is replaced or skipped by the
 * checkbox, and one failure does not stop the rest.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { type SendResult, summarize, uploadBatch } from "../frontdoor/app/admin/library/upload-batch.ts";

const f = (name: string, size = 10) => ({ name, size });

describe("library multi-file upload", () => {
	it("sends files in order and reports added and replaced", async () => {
		const seen: string[] = [];
		const out = await uploadBatch([f("a.pdf"), f("b.pdf")], {
			maxMb: 100,
			replace: true,
			send: async (file, replace) => {
				seen.push(`${file.name}:${replace}`);
				return { status: 200, body: { replaced: file.name === "b.pdf" } };
			},
		});
		assert.deepEqual(seen, ["a.pdf:true", "b.pdf:true"]);
		assert.deepEqual(out.map((o) => o.result), ["added", "replaced"]);
	});

	it("skips an existing file when replace is off and keeps going", async () => {
		const out = await uploadBatch([f("a.pdf"), f("b.pdf")], {
			maxMb: 100,
			replace: false,
			send: async (file): Promise<SendResult> => (file.name === "a.pdf" ? { status: 409, body: { code: "exists", error: "x" } } : { status: 200, body: {} }),
		});
		assert.deepEqual(out.map((o) => o.result), ["skipped", "added"]);
	});

	it("one failure does not stop the rest, and the message is kept", async () => {
		const out = await uploadBatch([f("a.pdf"), f("b.exe"), f("c.pdf"), f("d.pdf")], {
			maxMb: 100,
			replace: false,
			send: async (file) => {
				if (file.name === "b.exe") return { status: 400, body: { error: "That file type is not allowed." } };
				if (file.name === "c.pdf") throw new Error("The upload stopped.");
				return { status: 200, body: {} };
			},
		});
		assert.deepEqual(out.map((o) => o.result), ["added", "error", "error", "added"]);
		assert.equal(out[1]?.message, "That file type is not allowed.");
		assert.equal(out[2]?.message, "The upload stopped.");
		assert.equal(summarize(out), "Done. 2 added, 0 replaced, 0 skipped, 2 failed.");
	});

	it("refuses a file over the size limit without sending it", async () => {
		let sent = 0;
		const out = await uploadBatch([f("big.pdf", 3 * 1024 * 1024), f("ok.pdf")], {
			maxMb: 2,
			replace: false,
			send: async () => {
				sent++;
				return { status: 200, body: {} };
			},
		});
		assert.equal(sent, 1);
		assert.equal(out[0]?.result, "error");
		assert.equal(out[0]?.message, "Files can be up to 2 MB.");
	});

	it("reports progress as done of total", async () => {
		const marks: string[] = [];
		await uploadBatch([f("a.pdf"), f("b.pdf")], {
			maxMb: 100,
			replace: false,
			send: async () => ({ status: 200, body: {} }),
			onProgress: (done, total, current) => marks.push(`${done}/${total}/${current?.name ?? "-"}`),
		});
		assert.deepEqual(marks, ["0/2/a.pdf", "1/2/b.pdf", "2/2/-"]);
	});
});
