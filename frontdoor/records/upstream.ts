/**
 * What the study record reads from a tenant's upstream LearnHarness
 * server, and the checks that keep it honest (C6 req 1, C7 req 6 and 7).
 *
 * Read-only GETs only:
 *   GET /api/chats        session list: id, title, dates, kind, phase
 *   GET /api/chats/:id    one session: plan tree + native messages
 *   GET /api/graph        facts (propositions) with their provenance
 *
 * The types below are the minimal slice the record uses, not upstream's
 * full types. tests/frontdoor-records-contract.test.ts checks at compile
 * time that upstream's own types still fit them, and at run time (against
 * a real upstream server) that the JSON still parses. The parsers throw
 * UpstreamContractError on any shape they do not understand, so a changed
 * upstream fails loudly instead of printing a wrong record.
 *
 * Framework-free: plain fetch and plain TypeScript, no Next.js, no deps.
 */

export interface UpstreamChatSummary {
	id: string;
	title: string;
	createdAt: string;
	updatedAt: string;
	kind: "teach" | "practice";
	messageCount: number;
	phase: "probe" | "plan" | "teach";
}

export interface UpstreamPlanTree {
	nodes: Array<{ id: string; title: string }>;
	edges: Array<{ from: string; to: string }>;
	version: number;
}

/** One native message, loosely: the record reads only role and content. */
export interface UpstreamMessage {
	role: string;
	content?: unknown;
	timestamp?: number;
}

export interface UpstreamChatRecord {
	id: string;
	title: string;
	createdAt: string;
	updatedAt: string;
	/** Absent on older records; absent reads as "teach" (upstream's rule). */
	kind?: "teach" | "practice";
	tree?: UpstreamPlanTree;
	messages: UpstreamMessage[];
}

export interface UpstreamProposition {
	id: string;
	name: string;
	statement: string;
	createdAt: string;
	/** provenance[0].chatId is the birth session (a chat id, or "src_…" for imported notes). */
	provenance: Array<{ chatId: string }>;
}

export interface UpstreamGraph {
	propositions: UpstreamProposition[];
	/** chatId -> title, for every existing chat that touched the graph. */
	sessions: Record<string, string>;
	/** notes source id ("src_…") -> imported file path. */
	fileSources: Record<string, string>;
}

/** Everything the record builder needs, fetched in one pass. */
export interface RecordSource {
	chats: UpstreamChatSummary[];
	/** chatId -> full record, for every listed session with messages. */
	records: Record<string, UpstreamChatRecord>;
	graph: UpstreamGraph;
}

export class UpstreamContractError extends Error {
	constructor(
		readonly route: string,
		detail: string,
	) {
		super(`Upstream ${route} changed shape: ${detail}`);
		this.name = "UpstreamContractError";
	}
}

// ─── small checks ────────────────────────────────────────────────────────────

type Obj = Record<string, unknown>;

function isObj(v: unknown): v is Obj {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

function str(route: string, o: Obj, key: string, where: string): string {
	const v = o[key];
	if (typeof v !== "string") throw new UpstreamContractError(route, `${where}.${key} is not a string`);
	return v;
}

function iso(route: string, o: Obj, key: string, where: string): string {
	const v = str(route, o, key, where);
	if (Number.isNaN(Date.parse(v))) throw new UpstreamContractError(route, `${where}.${key} is not a date`);
	return v;
}

function stringMap(route: string, v: unknown, where: string): Record<string, string> {
	if (!isObj(v)) throw new UpstreamContractError(route, `${where} is not an object`);
	const out: Record<string, string> = {};
	for (const [k, val] of Object.entries(v)) {
		if (typeof val !== "string") throw new UpstreamContractError(route, `${where}["${k}"] is not a string`);
		out[k] = val;
	}
	return out;
}

const KINDS = new Set(["teach", "practice"]);
const PHASES = new Set(["probe", "plan", "teach"]);

// ─── parsers ─────────────────────────────────────────────────────────────────

/** GET /api/chats -> { chats: ChatListItem[] } */
export function parseChatList(json: unknown): UpstreamChatSummary[] {
	const route = "GET /api/chats";
	if (!isObj(json) || !Array.isArray(json.chats)) throw new UpstreamContractError(route, "body.chats is not an array");
	return json.chats.map((c, i) => {
		const where = `chats[${i}]`;
		if (!isObj(c)) throw new UpstreamContractError(route, `${where} is not an object`);
		const kind = c.kind;
		if (typeof kind !== "string" || !KINDS.has(kind)) throw new UpstreamContractError(route, `${where}.kind is not teach or practice`);
		const phase = c.phase;
		if (typeof phase !== "string" || !PHASES.has(phase)) throw new UpstreamContractError(route, `${where}.phase is not probe, plan or teach`);
		const messageCount = c.messageCount;
		if (typeof messageCount !== "number" || !Number.isInteger(messageCount) || messageCount < 0) {
			throw new UpstreamContractError(route, `${where}.messageCount is not a count`);
		}
		return {
			id: str(route, c, "id", where),
			title: str(route, c, "title", where),
			createdAt: iso(route, c, "createdAt", where),
			updatedAt: iso(route, c, "updatedAt", where),
			kind: kind as UpstreamChatSummary["kind"],
			messageCount,
			phase: phase as UpstreamChatSummary["phase"],
		};
	});
}

function parseTree(route: string, v: unknown): UpstreamPlanTree {
	if (!isObj(v) || !Array.isArray(v.nodes) || !Array.isArray(v.edges) || typeof v.version !== "number") {
		throw new UpstreamContractError(route, "tree is not { nodes, edges, version }");
	}
	const nodes = v.nodes.map((nd, i) => {
		if (!isObj(nd)) throw new UpstreamContractError(route, `tree.nodes[${i}] is not an object`);
		return { id: str(route, nd, "id", `tree.nodes[${i}]`), title: str(route, nd, "title", `tree.nodes[${i}]`) };
	});
	const edges = v.edges.map((e, i) => {
		if (!isObj(e)) throw new UpstreamContractError(route, `tree.edges[${i}] is not an object`);
		return { from: str(route, e, "from", `tree.edges[${i}]`), to: str(route, e, "to", `tree.edges[${i}]`) };
	});
	return { nodes, edges, version: v.version };
}

/** GET /api/chats/:id -> the chat record (plus live fields the record ignores). */
export function parseChatRecord(json: unknown): UpstreamChatRecord {
	const route = "GET /api/chats/:id";
	if (!isObj(json)) throw new UpstreamContractError(route, "body is not an object");
	if (!Array.isArray(json.messages)) throw new UpstreamContractError(route, "messages is not an array");
	const messages = json.messages.map((m, i): UpstreamMessage => {
		if (!isObj(m) || typeof m.role !== "string") throw new UpstreamContractError(route, `messages[${i}] has no role`);
		return { role: m.role, content: m.content, ...(typeof m.timestamp === "number" ? { timestamp: m.timestamp } : {}) };
	});
	const kind = json.kind;
	if (kind !== undefined && (typeof kind !== "string" || !KINDS.has(kind))) {
		throw new UpstreamContractError(route, "kind is not teach or practice");
	}
	return {
		id: str(route, json, "id", "body"),
		title: str(route, json, "title", "body"),
		createdAt: iso(route, json, "createdAt", "body"),
		updatedAt: iso(route, json, "updatedAt", "body"),
		...(kind !== undefined ? { kind: kind as UpstreamChatSummary["kind"] } : {}),
		...(json.tree !== undefined ? { tree: parseTree(route, json.tree) } : {}),
		messages,
	};
}

/** GET /api/graph -> GraphSnapshot (the record reads propositions, sessions, fileSources). */
export function parseGraph(json: unknown): UpstreamGraph {
	const route = "GET /api/graph";
	if (!isObj(json) || !Array.isArray(json.propositions)) throw new UpstreamContractError(route, "propositions is not an array");
	const propositions = json.propositions.map((p, i): UpstreamProposition => {
		const where = `propositions[${i}]`;
		if (!isObj(p)) throw new UpstreamContractError(route, `${where} is not an object`);
		if (!Array.isArray(p.provenance)) throw new UpstreamContractError(route, `${where}.provenance is not an array`);
		const provenance = p.provenance.map((pt, k) => {
			if (!isObj(pt)) throw new UpstreamContractError(route, `${where}.provenance[${k}] is not an object`);
			return { chatId: str(route, pt, "chatId", `${where}.provenance[${k}]`) };
		});
		return {
			id: str(route, p, "id", where),
			name: str(route, p, "name", where),
			statement: str(route, p, "statement", where),
			createdAt: iso(route, p, "createdAt", where),
			provenance,
		};
	});
	return {
		propositions,
		sessions: stringMap(route, json.sessions, "sessions"),
		fileSources: stringMap(route, json.fileSources, "fileSources"),
	};
}

// ─── the read ────────────────────────────────────────────────────────────────

type FetchLike = (input: string, init?: { headers?: Record<string, string> }) => Promise<Response>;

async function getJson(fetchImpl: FetchLike, base: string, route: string, path: string): Promise<{ status: number; json: unknown }> {
	const res = await fetchImpl(base + path, { headers: { accept: "application/json" } });
	if (res.status === 404) {
		await res.arrayBuffer().catch(() => undefined);
		return { status: 404, json: null };
	}
	if (!res.ok) {
		await res.arrayBuffer().catch(() => undefined);
		throw new Error(`Upstream ${route} answered ${res.status}`);
	}
	return { status: res.status, json: await res.json() };
}

/**
 * Read everything the record needs from one tenant's upstream server.
 * Only GETs. Sessions with no messages are not fetched (the record leaves
 * them out). A session deleted between the list and its own read (404) is
 * skipped. `fetchImpl` lets the front door add its own headers or timeouts.
 */
export async function fetchRecordSource(baseUrl: string, fetchImpl: FetchLike = fetch): Promise<RecordSource> {
	const base = baseUrl.replace(/\/+$/, "");
	const list = await getJson(fetchImpl, base, "GET /api/chats", "/api/chats");
	if (list.status === 404) throw new Error("Upstream GET /api/chats answered 404");
	const chats = parseChatList(list.json);

	const records: Record<string, UpstreamChatRecord> = {};
	const wanted = chats.filter((c) => c.messageCount > 0);
	const CONCURRENCY = 4;
	for (let i = 0; i < wanted.length; i += CONCURRENCY) {
		await Promise.all(
			wanted.slice(i, i + CONCURRENCY).map(async (c) => {
				const res = await getJson(fetchImpl, base, "GET /api/chats/:id", `/api/chats/${encodeURIComponent(c.id)}`);
				if (res.status === 404) return;
				const rec = parseChatRecord(res.json);
				if (rec.id !== c.id) throw new UpstreamContractError("GET /api/chats/:id", `asked for ${c.id}, got ${rec.id}`);
				records[c.id] = rec;
			}),
		);
	}

	const graph = await getJson(fetchImpl, base, "GET /api/graph", "/api/graph");
	if (graph.status === 404) throw new Error("Upstream GET /api/graph answered 404");
	return { chats, records, graph: parseGraph(graph.json) };
}
