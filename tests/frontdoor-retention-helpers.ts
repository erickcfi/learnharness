/**
 * Helpers for the retention and pause tests: a zip reader (so the tests
 * check the export with code other than the writer's) and a fake tenant
 * server's API answers. A helper, not a test file.
 */
import { crc32, inflateRawSync } from "node:zlib";

export interface ReadEntry {
	name: string;
	data: Buffer;
	method: number;
	flags: number;
}

/** Reads a classic zip through its central directory, checking every CRC and size. */
export function readZip(zip: Buffer): Map<string, ReadEntry> {
	const endAt = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
	if (endAt < 0) throw new Error("no end of central directory");
	const count = zip.readUInt16LE(endAt + 10);
	let at = zip.readUInt32LE(endAt + 16);
	const out = new Map<string, ReadEntry>();
	for (let i = 0; i < count; i++) {
		if (zip.readUInt32LE(at) !== 0x02014b50) throw new Error(`bad central header ${i}`);
		const flags = zip.readUInt16LE(at + 8);
		const method = zip.readUInt16LE(at + 10);
		const crc = zip.readUInt32LE(at + 16);
		const csize = zip.readUInt32LE(at + 20);
		const usize = zip.readUInt32LE(at + 24);
		const nameLen = zip.readUInt16LE(at + 28);
		const extraLen = zip.readUInt16LE(at + 30);
		const commentLen = zip.readUInt16LE(at + 32);
		const local = zip.readUInt32LE(at + 42);
		const name = zip.subarray(at + 46, at + 46 + nameLen).toString("utf8");
		if (zip.readUInt32LE(local) !== 0x04034b50) throw new Error(`bad local header for ${name}`);
		const localName = zip.readUInt16LE(local + 26);
		const localExtra = zip.readUInt16LE(local + 28);
		const start = local + 30 + localName + localExtra;
		const raw = zip.subarray(start, start + csize);
		const data = method === 0 ? Buffer.from(raw) : method === 8 ? inflateRawSync(raw) : null;
		if (!data) throw new Error(`unknown method ${method}`);
		if (data.length !== usize) throw new Error(`size mismatch for ${name}`);
		if (crc32(data) !== crc) throw new Error(`crc mismatch for ${name}`);
		out.set(name, { name, data, method, flags });
		at += 46 + nameLen + extraLen + commentLen;
	}
	return out;
}

export const CHAT_A = "chat_a1";
export const CHAT_B = "chat_b2";

/** GET answers of a small upstream tenant: two sessions, a graph with one fact from notes. */
export function fakeUpstreamAnswers(): Record<string, unknown> {
	const chatA = {
		id: CHAT_A,
		title: "Decode a METAR",
		createdAt: "2026-11-01T15:00:00.000Z",
		updatedAt: "2026-11-01T16:00:00.000Z",
		kind: "teach",
		messageCount: 2,
		phase: "teach",
	};
	const chatB = { ...chatA, id: CHAT_B, title: "Class B airspace", createdAt: "2026-11-03T15:00:00.000Z", updatedAt: "2026-11-03T15:30:00.000Z" };
	const record = (c: typeof chatA) => ({
		id: c.id,
		title: c.title,
		createdAt: c.createdAt,
		updatedAt: c.updatedAt,
		kind: "teach",
		tree: { nodes: [{ id: "n1", title: `${c.title} basics` }], edges: [], version: 1 },
		messages: [
			{ role: "user", content: `Teach me: ${c.title}`, timestamp: Date.parse(c.createdAt) },
			{ role: "assistant", content: "Sure.", timestamp: Date.parse(c.createdAt) + 1000 },
		],
	});
	return {
		"/api/chats": { chats: [chatB, chatA] },
		[`/api/chats/${CHAT_A}`]: record(chatA),
		[`/api/chats/${CHAT_B}`]: record(chatB),
		[`/api/chats/${CHAT_A}/markdown`]: "# Decode a METAR\n\nKSFO 081756Z 28012KT 10SM FEW015\n",
		[`/api/chats/${CHAT_B}/markdown`]: "# Class B airspace\n\nTen thousand feet MSL.\n",
		"/api/graph": {
			propositions: [
				{ id: "p1", name: "METAR wind", statement: "Wind is true direction in tens of degrees.", createdAt: "2026-11-01T15:30:00.000Z", provenance: [{ chatId: CHAT_A }] },
				{ id: "p2", name: "Notes fact", statement: "From my own notes.", createdAt: "2026-11-02T10:00:00.000Z", provenance: [{ chatId: "src_n1" }] },
			],
			sessions: { [CHAT_A]: "Decode a METAR" },
			fileSources: { src_n1: "my-notes.md" },
		},
		"/api/graph/sources": { sources: [{ id: "src_n1", path: "my-notes.md", importedAt: "2026-11-02T10:00:00.000Z" }] },
	};
}

/** A TenantFetch over fixed answers. Unknown paths answer 404; `fail` paths answer 500. */
export function fakeTenantFetch(answers: Record<string, unknown>, fail: Set<string> = new Set()) {
	const seen: string[] = [];
	const fetchTenant = async (_tenantId: string, path: string): Promise<Response> => {
		seen.push(path);
		const key = path.split("?")[0] as string;
		if (fail.has(key)) return new Response("boom", { status: 500 });
		if (!(key in answers)) return new Response("not found", { status: 404 });
		const v = answers[key];
		return typeof v === "string" ? new Response(v, { headers: { "content-type": "text/markdown" } }) : Response.json(v);
	};
	return { fetchTenant, seen };
}
