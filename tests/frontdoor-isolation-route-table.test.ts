/**
 * W2-6 (P2-03, PRD C3 requirements 1 and 2, section 4 fact 6): the route
 * table. Every upstream API route and method is classified, the routes the
 * PRD names are refused, and the one checked route (PUT /api/settings/agent)
 * lets only the Owner's models and File access through.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, it } from "node:test";
import { agentSettingsProblem, OWNER_SETTING_MESSAGE, sameJson } from "../frontdoor/gateway/route-guard.ts";
import { decideRoute, findRule, NOT_LISTED, STUDENT_ROUTES } from "../frontdoor/gateway/route-policy.ts";

const API_DIR = path.join(import.meta.dirname, "..", "app", "api");
const METHOD_EXPORT = /export\s+(?:async\s+)?(?:function|const)\s+(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b/g;

/** Every route file in app/api, as "/api/..." with its exported methods. */
function upstreamRoutes(): Array<{ route: string; methods: string[] }> {
	const out: Array<{ route: string; methods: string[] }> = [];
	const walk = (dir: string) => {
		for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) walk(full);
			else if (entry.name === "route.ts") {
				const route = `/api/${path.relative(API_DIR, dir).split(path.sep).join("/")}`.replace(/\/$/, "");
				const methods = [...fs.readFileSync(full, "utf8").matchAll(METHOD_EXPORT)].map((m) => m[1] as string);
				out.push({ route, methods: [...new Set(methods)].sort() });
			}
		}
	};
	walk(API_DIR);
	return out.sort((a, b) => a.route.localeCompare(b.route));
}

const TEMPLATE = { fileAccess: { restricted: true, folders: ["/data/library"] } };

describe("the route table covers every upstream route", () => {
	it("has a row for every route file in app/api, with exactly the methods it exports", () => {
		const routes = upstreamRoutes();
		assert.ok(routes.length >= 30, `found only ${routes.length} route files`);
		const problems: string[] = [];
		for (const { route, methods } of routes) {
			if (methods.length === 0) problems.push(`${route}: no exported methods found`);
			const row = STUDENT_ROUTES.find((r) => r.path === route);
			if (!row) {
				problems.push(`${route}: no row`);
				continue;
			}
			if (!sameJson([...row.methods].sort(), methods)) problems.push(`${route}: row has ${row.methods.join(",")}, upstream exports ${methods.join(",")}`);
		}
		assert.deepEqual(problems, []);
	});

	it("has a concrete row for every upstream settings section", async () => {
		const { SETTINGS_SECTIONS } = await import("../src/server/settings-body.ts");
		const missing = Object.keys(SETTINGS_SECTIONS).filter((section) => !STUDENT_ROUTES.some((r) => r.path === `/api/settings/${section}`));
		assert.deepEqual(missing, []);
	});

	it("names no route that upstream does not have (other than settings sections)", () => {
		const real = new Set(upstreamRoutes().map((r) => r.route));
		const extra = STUDENT_ROUTES.filter((r) => !real.has(r.path) && !r.path.startsWith("/api/settings/")).map((r) => r.path);
		assert.deepEqual(extra, []);
	});

	it("documents every row in docs/decisions", () => {
		const doc = fs.readFileSync(path.join(import.meta.dirname, "..", "docs", "decisions", "2026-11-08-route-blocks.md"), "utf8");
		const missing = STUDENT_ROUTES.filter((r) => !doc.includes(`\`${r.path}\``)).map((r) => r.path);
		assert.deepEqual(missing, []);
	});
});

describe("the routes the PRD names are refused (section 4, fact 6)", () => {
	const refused: Array<[string, string]> = [
		["GET", "/api/keys"],
		["PUT", "/api/keys/ANTHROPIC_API_KEY"],
		["DELETE", "/api/keys/TAVILY_API_KEY"],
		["GET", "/api/claude-code"],
		["GET", "/api/custom-provider"],
		["POST", "/api/custom-provider"],
		["PATCH", "/api/custom-provider"],
		["DELETE", "/api/custom-provider"],
		["GET", "/api/subscriptions"],
		["POST", "/api/subscriptions"],
		["GET", "/api/subscriptions/browser"],
		["POST", "/api/subscriptions/browser"],
		["GET", "/api/stt/token"],
		["GET", "/api/settings/prompts"],
		["PUT", "/api/settings/prompts/teacher/base.md"],
		["DELETE", "/api/settings/prompts/teacher/base.md"],
		["PUT", "/api/settings/models"],
		["PUT", "/api/settings/chat"],
		["PUT", "/api/settings/claudeCode"],
		["PUT", "/api/settings/dictation"],
		["PUT", "/api/settings/customProvider"],
		["PUT", "/api/settings/somethingNew"],
		["PUT", "/api/chats/chat_abc/settings"],
	];
	for (const [method, pathname] of refused) {
		it(`${method} ${pathname} → 403 with a message`, () => {
			const decision = decideRoute(method, pathname);
			assert.equal(decision.kind, "refuse");
			if (decision.kind !== "refuse") return;
			assert.equal(decision.status, 403);
			assert.ok(decision.message.length > 10);
		});
	}

	it("the model and thinking refusals say who sets them", () => {
		for (const pathname of ["/api/settings/models", "/api/settings/chat", "/api/chats/x/settings"]) {
			const decision = decideRoute("PUT", pathname);
			assert.ok(decision.kind === "refuse" && /North Aero sets the AI model and thinking level/.test(decision.message), pathname);
		}
	});
});

describe("route decisions", () => {
	it("lets a student's study routes through", () => {
		for (const [method, pathname] of [
			["GET", "/api/chats"],
			["POST", "/api/chats"],
			["POST", "/api/chat"],
			["GET", "/api/chats/chat_1/stream"],
			["GET", "/api/events"],
			["DELETE", "/api/graph/nodes/n1"],
			["POST", "/api/graph/import"],
			["PUT", "/api/settings/appearance"],
			["PUT", "/api/settings/graph"],
			["PUT", "/api/settings/compaction"],
			["GET", "/api/settings"],
			["GET", "/api/models"],
		]) {
			assert.equal(decideRoute(method as string, pathname as string).kind, "pass", `${method} ${pathname}`);
		}
	});

	it("treats HEAD as GET", () => {
		assert.equal(decideRoute("HEAD", "/api/chats").kind, "pass");
		assert.equal(decideRoute("HEAD", "/api/keys").kind, "refuse");
	});

	it("refuses read-only routes' writes and any method upstream does not export", () => {
		for (const [method, pathname] of [
			["POST", "/api/settings"],
			["DELETE", "/api/models"],
			["OPTIONS", "/api/chats"],
			["PATCH", "/api/chats/c1"],
		]) {
			const decision = decideRoute(method as string, pathname as string);
			assert.ok(decision.kind === "refuse" && decision.status === 403, `${method} ${pathname}`);
		}
	});

	it("refuses an API path no row names (default deny), in any letter case", () => {
		for (const pathname of ["/api", "/api/", "/api/new-upstream-route", "/API/keys", "/Api/chats", "/api/chats/c1/settings/extra", "/api/keys/"]) {
			const decision = decideRoute("GET", pathname);
			assert.ok(decision.kind === "refuse" && decision.status === 403 && decision.message === NOT_LISTED, pathname);
		}
	});

	it("refuses paths with empty segments or encoded slashes before any table lookup", () => {
		for (const pathname of ["//api/keys", "/api//keys", "/api/chats/a%2F..%2F..%2Fkeys/markdown", "/api/chats/a%5Ckeys", "/chat//x"]) {
			const decision = decideRoute("GET", pathname);
			assert.ok(decision.kind === "refuse" && decision.status === 400, pathname);
		}
	});

	it("passes page reads and refuses page writes (upstream has no Server Actions)", () => {
		assert.equal(decideRoute("GET", "/").kind, "pass");
		assert.equal(decideRoute("GET", "/chat/new").kind, "pass");
		assert.equal(decideRoute("GET", "/_next/static/chunks/app.js").kind, "pass");
		for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
			const decision = decideRoute(method, "/chat/new");
			assert.ok(decision.kind === "refuse" && decision.status === 403, method);
		}
	});

	it("redirects a blocked page home", () => {
		assert.equal(decideRoute("GET", "/secret-page", STUDENT_ROUTES, ["/secret-page"]).kind, "redirect-home");
	});

	it("a concrete row wins over a dynamic one", () => {
		assert.equal(findRule("/api/settings/agent")?.path, "/api/settings/agent");
		assert.equal(findRule("/api/settings/whatever")?.path, "/api/settings/[section]");
		assert.equal(findRule("/api/settings/prompts")?.path, "/api/settings/prompts");
		assert.equal(findRule("/api/settings/prompts/a/b/c.md")?.path, "/api/settings/prompts/[...segment]");
	});

	it("sends the agent section to the body check", () => {
		assert.equal(decideRoute("PUT", "/api/settings/agent").kind, "check-agent-settings");
	});
});

describe("the agent-section check (model lock, File access)", () => {
	const ui = { tools: { research: false }, search: { engine: "tavily" }, graphTools: { enabled: true }, prompts: {}, fileAccess: { restricted: true, folders: ["/data/library"] } };

	it("lets a body with the Owner's File access and no per-role models through", () => {
		assert.equal(agentSettingsProblem(ui, TEMPLATE), null);
		assert.equal(agentSettingsProblem({ ...ui, models: {} }, TEMPLATE), null);
		assert.equal(agentSettingsProblem({ ...ui, fileAccess: { folders: ["/data/library"], restricted: true } }, TEMPLATE), null, "key order does not matter");
	});

	it("refuses a per-role model override", () => {
		assert.equal(agentSettingsProblem({ ...ui, models: { researcher: { model: { provider: "anthropic", id: "claude-haiku-5-5" } } } }, TEMPLATE), OWNER_SETTING_MESSAGE);
		assert.equal(agentSettingsProblem({ ...ui, models: { extractor: { thinkingLevel: "max" } } }, TEMPLATE), OWNER_SETTING_MESSAGE);
	});

	it("refuses any change to File access, including dropping it", () => {
		for (const fileAccess of [undefined, { restricted: false, folders: ["/data/library"] }, { restricted: true, folders: ["/data/library", "/"] }, { restricted: true, folders: [] }, { restricted: true, folders: ["/data/library/"] }, { restricted: true }]) {
			assert.equal(agentSettingsProblem({ ...ui, fileAccess }, TEMPLATE), OWNER_SETTING_MESSAGE, JSON.stringify(fileAccess));
		}
	});

	it("calls a non-object body invalid", () => {
		for (const body of [null, [], "x", 3]) assert.equal(agentSettingsProblem(body, TEMPLATE), "Invalid JSON body");
	});
});
