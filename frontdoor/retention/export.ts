/**
 * The student's data export (P1-08; C1 req 6, D20, D25): one zip with
 *
 *   README.txt             what is inside, with the N8 label
 *   sessions/NNN-....md    each session, from upstream's own markdown export
 *                          (GET /api/chats/<id>/markdown)
 *   study-record.html      the printable study record (frontdoor/records)
 *   knowledge-graph.json   GET /api/graph, as upstream answers it
 *   imported-notes.json    GET /api/graph/sources: the notes files imported
 *                          and when (upstream keeps no copy of the files
 *                          themselves; their facts are in the graph)
 *
 * Everything is read through the tenant's own server (read-only GETs), the
 * same upstream API the record and the contract tests use. The session
 * list must answer, or the export fails; any other part that fails is left
 * out and named in README.txt, so the student still gets the rest.
 *
 * No session text reaches a log: callers log ids and sizes only.
 */
import { buildStudyRecord, fetchRecordSource, parseChatList, renderStudyRecordHtml } from "../records/index.ts";
import { EXPORT_README } from "../pause/copy.ts";
import { createZip, type ZipEntry } from "./zip.ts";

/** A GET to the tenant's own server: path like "/api/chats". wiring supplies it (supervisor port, plus any per-tenant header). */
export type TenantFetch = (tenantId: string, path: string) => Promise<Response>;

export interface RecordInputs {
	tenantId: string;
	fetchTenant: TenantFetch;
	/** From the student's login; "Student" when unknown. */
	studentName: string;
	/** IANA zone for the dates on the record. */
	timeZone: string;
	/** Front door active seconds per upstream chat id (PD1). */
	activeSecondsBySession: Readonly<Record<string, number>>;
	now: Date;
}

export interface ExportResult {
	fileName: string;
	body: Buffer;
	sessions: number;
	/** Parts left out, by file name. */
	missing: string[];
}

class TenantAnswerError extends Error {
	constructor(path: string, status: number) {
		super(`tenant answered ${status} to GET ${path.split("?")[0]}`);
		this.name = "TenantAnswerError";
	}
}

async function getText(o: RecordInputs, path: string): Promise<string> {
	const res = await o.fetchTenant(o.tenantId, path);
	if (!res.ok) {
		await res.arrayBuffer().catch(() => undefined);
		throw new TenantAnswerError(path, res.status);
	}
	return res.text();
}

/** Filename-safe text, like upstream's own slug for markdown exports. */
export function slugify(text: string): string {
	const slug = text
		.toLowerCase()
		.normalize("NFKD")
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 60)
		.replace(/-+$/g, "");
	return slug || "session";
}

const day = (iso: string) => (/^\d{4}-\d{2}-\d{2}/.test(iso) ? iso.slice(0, 10) : "undated");

/** The printable study record as one HTML document. */
export async function buildRecordHtml(o: RecordInputs): Promise<string> {
	const base = "http://tenant.invalid";
	const source = await fetchRecordSource(base, (url) => {
		const u = new URL(url);
		return o.fetchTenant(o.tenantId, `${u.pathname}${u.search}`);
	});
	const record = buildStudyRecord(source, {
		studentName: o.studentName,
		printedAt: o.now,
		timeZone: o.timeZone,
		activeSecondsBySession: o.activeSecondsBySession,
	});
	return renderStudyRecordHtml(record);
}

export async function buildExport(o: RecordInputs): Promise<ExportResult> {
	const entries: ZipEntry[] = [];
	const missing: string[] = [];

	// The session list must answer; without it there is nothing to give.
	const chats = parseChatList(JSON.parse(await getText(o, "/api/chats")) as unknown);
	const ordered = [...chats].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
	let index = 0;
	for (const chat of ordered) {
		index += 1;
		const name = `sessions/${String(index).padStart(3, "0")}-${day(chat.createdAt)}-${slugify(chat.title)}.md`;
		try {
			entries.push({ name, data: await getText(o, `/api/chats/${encodeURIComponent(chat.id)}/markdown`) });
		} catch {
			missing.push(name);
		}
	}

	const optional: Array<[string, () => Promise<string>]> = [
		["study-record.html", () => buildRecordHtml(o)],
		["knowledge-graph.json", () => getText(o, "/api/graph")],
		["imported-notes.json", () => getText(o, "/api/graph/sources")],
	];
	for (const [name, read] of optional) {
		try {
			entries.push({ name, data: await read() });
		} catch {
			missing.push(name);
		}
	}

	const r = EXPORT_README;
	const made = o.now.toISOString().slice(0, 16).replace("T", " ");
	const readme = [
		r.title,
		r.made(made),
		"",
		r.label,
		"",
		r.contentsHeading,
		...r.contents.map((line) => `- ${line}`),
		...(missing.length ? ["", r.missingHeading, ...missing.map((m) => `- ${m}`)] : []),
		"",
		r.contact,
		"",
	].join("\r\n");
	entries.unshift({ name: "README.txt", data: readme });

	return {
		fileName: `ground-tutor-data-${o.now.toISOString().slice(0, 10)}.zip`,
		body: createZip(entries, o.now),
		sessions: entries.filter((e) => e.name.startsWith("sessions/")).length,
		missing,
	};
}
