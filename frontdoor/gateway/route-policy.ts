/**
 * Which upstream routes a student may use (PRD C3 requirements 1 and 2,
 * section 4 fact 6, N2, N3, N13; card P2-03). The front door checks every
 * logged-in request against this table before it passes the request to the
 * student's own LearnHarness server. Nothing here changes upstream routes.
 *
 * Every route file in app/api and every method it exports has a row. A
 * test walks app/api and fails when a route or method has none, so a new
 * upstream route is noticed. Until it is classified, it is refused: an
 * /api path or method that no row names gets 403 (default deny).
 *
 * Access classes (the table in docs/decisions/2026-11-08-route-blocks.md):
 *   allowed    the student's own data and study actions; passes as is
 *   read-only  GET (and HEAD) passes, nothing else
 *   blocked    403 with a plain JSON message
 *   checked    PUT /api/settings/agent: passes only when the per-role models
 *              and File access in the body are the Owner's (route-guard.ts)
 *
 * Pages (everything outside /api) pass on GET and HEAD. Upstream has no
 * Server Actions, so any other method on a page path is refused. No upstream
 * page needs blocking today; BLOCKED_PAGES redirects home if one ever does.
 *
 * Framework-free, runnable by plain Node (type stripping).
 */

export type RouteAccess = "allowed" | "read-only" | "blocked" | "checked";

export interface RouteRule {
	/** As in app/api, with [id] for one segment and [...name] for one or more.
	 *  A path with fewer dynamic segments wins over one with more. */
	path: string;
	/** The methods upstream exports for this route (HEAD follows GET). */
	methods: readonly string[];
	access: RouteAccess;
	/** Plain words. For blocked rows this is also the 403 message. */
	reason: string;
}

const MODELS = "North Aero sets the AI model and thinking level. They can't be changed here.";
const KEYS = "North Aero holds the AI keys. Keys and providers can't be seen or changed here.";
const PROVIDERS = "Other AI providers and subscriptions are turned off in North Aero Ground Tutor.";
const DICTATION = "Dictation is turned off in North Aero Ground Tutor.";
const PROMPTS = "The tutor's instructions are set by North Aero and can't be changed here.";

/** Every upstream API route, and what a student may do with it. */
export const STUDENT_ROUTES: readonly RouteRule[] = [
	{ path: "/api/activity", methods: ["GET"], access: "allowed", reason: "The student's own running work." },
	{ path: "/api/activity/abort", methods: ["POST"], access: "allowed", reason: "Stops the student's own running work." },
	{ path: "/api/chat", methods: ["POST"], access: "allowed", reason: "A teaching turn. The meter counts it and refuses it while the student is paused." },
	{ path: "/api/chats", methods: ["GET", "POST"], access: "allowed", reason: "The session list, and a new session (it takes the Owner's Strong model from settings.json)." },
	{ path: "/api/chats/[id]", methods: ["GET", "PUT", "DELETE"], access: "allowed", reason: "Read, rename or delete one of the student's own sessions." },
	{ path: "/api/chats/[id]/artifact-ui", methods: ["POST"], access: "allowed", reason: "Answers inside a demo or quiz card." },
	{ path: "/api/chats/[id]/dismiss", methods: ["POST"], access: "allowed", reason: "Dismisses a card in the student's own session." },
	{ path: "/api/chats/[id]/images/[snapshotId]", methods: ["GET"], access: "allowed", reason: "Images in the student's own session." },
	{ path: "/api/chats/[id]/markdown", methods: ["GET"], access: "allowed", reason: "Exports one session as markdown (also used by records)." },
	{ path: "/api/chats/[id]/settings", methods: ["PUT"], access: "blocked", reason: MODELS },
	{ path: "/api/chats/[id]/steer", methods: ["POST"], access: "allowed", reason: "Steers a running turn." },
	{ path: "/api/chats/[id]/stream", methods: ["GET"], access: "allowed", reason: "The session's live stream (server-sent events)." },
	{ path: "/api/claude-code", methods: ["GET"], access: "blocked", reason: PROVIDERS },
	{ path: "/api/custom-provider", methods: ["GET", "POST", "PATCH", "DELETE"], access: "blocked", reason: PROVIDERS },
	{ path: "/api/events", methods: ["GET"], access: "allowed", reason: "The app's notification stream (server-sent events)." },
	{ path: "/api/graph", methods: ["GET"], access: "allowed", reason: "The student's knowledge graph." },
	{ path: "/api/graph/costs", methods: ["GET"], access: "read-only", reason: "What the student's graph work cost, as upstream shows it." },
	{ path: "/api/graph/coverage/extract", methods: ["POST"], access: "allowed", reason: "Runs graph extraction for a session. The meter counts it." },
	{ path: "/api/graph/import", methods: ["POST"], access: "allowed", reason: "The student imports their own notes and PDFs (N4), 20 MB per file. The meter counts it." },
	{ path: "/api/graph/nodes/[id]", methods: ["DELETE"], access: "allowed", reason: "Deletes a fact from the student's own graph." },
	{ path: "/api/graph/positions", methods: ["PUT"], access: "allowed", reason: "Saves the graph layout." },
	{ path: "/api/graph/render-settings", methods: ["GET", "PUT"], access: "allowed", reason: "The graph view's display settings." },
	{ path: "/api/graph/sources", methods: ["GET", "DELETE", "POST"], access: "allowed", reason: "The student's imported notes." },
	{ path: "/api/graph/status", methods: ["GET"], access: "allowed", reason: "Graph extraction status." },
	{ path: "/api/jobs", methods: ["GET"], access: "allowed", reason: "The student's background jobs." },
	{ path: "/api/keys", methods: ["GET"], access: "blocked", reason: KEYS },
	{ path: "/api/keys/[id]", methods: ["PUT", "DELETE"], access: "blocked", reason: KEYS },
	{ path: "/api/models", methods: ["GET"], access: "read-only", reason: "The model catalog the composer reads. It names providers and whether a key exists, never a key." },
	{ path: "/api/search", methods: ["GET"], access: "read-only", reason: "Whether web search works. Never a key." },
	{ path: "/api/settings", methods: ["GET"], access: "read-only", reason: "The settings record. It holds no secret." },
	// One settings section per PUT. A known section has its own row; any other
	// section is refused (the dynamic row below).
	{ path: "/api/settings/general", methods: ["PUT"], access: "allowed", reason: "General app settings (automatic update checks, desktop only)." },
	{ path: "/api/settings/appearance", methods: ["PUT"], access: "allowed", reason: "Colors and fonts." },
	{ path: "/api/settings/graph", methods: ["PUT"], access: "allowed", reason: "Graph settings." },
	{ path: "/api/settings/compaction", methods: ["PUT"], access: "allowed", reason: "When long sessions are summarized." },
	{ path: "/api/settings/agent", methods: ["PUT"], access: "checked", reason: "Tool switches, search engine and quiz style. Per-role models and File access must stay the Owner's." },
	{ path: "/api/settings/chat", methods: ["PUT"], access: "blocked", reason: MODELS },
	{ path: "/api/settings/models", methods: ["PUT"], access: "blocked", reason: MODELS },
	{ path: "/api/settings/claudeCode", methods: ["PUT"], access: "blocked", reason: PROVIDERS },
	{ path: "/api/settings/dictation", methods: ["PUT"], access: "blocked", reason: DICTATION },
	{ path: "/api/settings/[section]", methods: ["PUT"], access: "blocked", reason: "This setting can't be changed here." },
	{ path: "/api/settings/prompts", methods: ["GET"], access: "blocked", reason: PROMPTS },
	{ path: "/api/settings/prompts/[...segment]", methods: ["PUT", "DELETE"], access: "blocked", reason: PROMPTS },
	{ path: "/api/stt/token", methods: ["GET"], access: "blocked", reason: DICTATION },
	{ path: "/api/subscriptions", methods: ["GET", "POST"], access: "blocked", reason: PROVIDERS },
	{ path: "/api/subscriptions/browser", methods: ["GET", "POST"], access: "blocked", reason: PROVIDERS },
];

/** Upstream pages a student may not open (redirected home). None today. */
export const BLOCKED_PAGES: readonly string[] = [];

export const NOT_LISTED = "This part of LearnHarness isn't available in North Aero Ground Tutor.";

export type RouteDecision =
	| { kind: "pass" }
	| { kind: "check-agent-settings"; rule: RouteRule }
	| { kind: "refuse"; status: number; message: string; rule?: RouteRule }
	| { kind: "redirect-home" };

const segmentsOf = (p: string) => p.split("/").slice(1);

function matches(pattern: string, pathname: string): boolean {
	const want = segmentsOf(pattern);
	const got = segmentsOf(pathname);
	for (let i = 0; i < want.length; i++) {
		const w = want[i] ?? "";
		if (w.startsWith("[...")) return got.length > i && got.slice(i).every((s) => s !== "");
		const g = got[i];
		if (g === undefined || g === "") return false;
		if (w.startsWith("[")) continue;
		if (w !== g) return false;
	}
	return got.length === want.length;
}

const dynamicCount = (pattern: string) => segmentsOf(pattern).filter((s) => s.startsWith("[")).length;

/** The row for a path, or undefined. A concrete row beats a dynamic one. */
export function findRule(pathname: string, rules: readonly RouteRule[] = STUDENT_ROUTES): RouteRule | undefined {
	let best: RouteRule | undefined;
	for (const rule of rules) {
		if (!matches(rule.path, pathname)) continue;
		if (!best || dynamicCount(rule.path) < dynamicCount(best.path)) best = rule;
	}
	return best;
}

/** True for /api and below, in any letter case (so "/API/keys" can't slip past as a page). */
export function isApiPath(pathname: string): boolean {
	const lower = pathname.toLowerCase();
	return lower === "/api" || lower.startsWith("/api/");
}

/**
 * What the front door does with one logged-in request. `pathname` is the
 * gateway's normalized path ("..", "%2e%2e" already resolved).
 */
export function decideRoute(method: string, pathname: string, rules: readonly RouteRule[] = STUDENT_ROUTES, blockedPages: readonly string[] = BLOCKED_PAGES): RouteDecision {
	const verb = (method || "GET").toUpperCase();
	// An empty segment or an encoded slash or backslash never comes from the
	// app. Refusing them keeps the front door and Next.js reading one path.
	if (pathname.includes("//") || /%(2f|5c)/i.test(pathname)) return { kind: "refuse", status: 400, message: "Bad request." };

	if (!isApiPath(pathname)) {
		if (verb !== "GET" && verb !== "HEAD") return { kind: "refuse", status: 403, message: NOT_LISTED };
		if (blockedPages.some((page) => matches(page, pathname))) return { kind: "redirect-home" };
		return { kind: "pass" };
	}

	const rule = findRule(pathname, rules);
	if (!rule) return { kind: "refuse", status: 403, message: NOT_LISTED };
	const effective = verb === "HEAD" ? "GET" : verb;
	if (!rule.methods.includes(effective)) return { kind: "refuse", status: 403, message: NOT_LISTED, rule };
	switch (rule.access) {
		case "allowed":
			return { kind: "pass" };
		case "read-only":
			return effective === "GET" ? { kind: "pass" } : { kind: "refuse", status: 403, message: NOT_LISTED, rule };
		case "checked":
			return { kind: "check-agent-settings", rule };
		case "blocked":
			return { kind: "refuse", status: 403, message: rule.reason, rule };
	}
}
