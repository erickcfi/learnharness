/**
 * Applies the route table (route-policy.ts) to one logged-in request
 * (PRD C3 requirements 1 to 3, N2; cards P2-03 and P2-04).
 *
 * The one "checked" route, PUT /api/settings/agent, carries tool switches a
 * student may change next to two things only the Owner sets: the per-role
 * models (`models`) and File access (`fileAccess`). The guard reads that
 * body (64 KB at most), and refuses it unless both equal the Owner's
 * template. The bytes it read are then sent on unchanged.
 *
 * The body is decoded the way the tenant's route will decode it (UTF-8,
 * byte-order mark dropped, then JSON.parse), so both sides read the same
 * value. A body the guard cannot parse is refused, never forwarded.
 */
import type { IncomingMessage } from "node:http";
import { decideRoute, type RouteRule, BLOCKED_PAGES, STUDENT_ROUTES } from "./route-policy.ts";

/** What the Owner's template fixes inside the agent section. */
export interface OwnerAgentTemplate {
	/** agent.fileAccess as provisioning writes it (lockdown's library-only section). */
	fileAccess?: unknown;
	/** agent.models (per-role model overrides). The template sets none. */
	models?: unknown;
}

export interface RoutePolicy {
	rules: readonly RouteRule[];
	blockedPages: readonly string[];
	agentTemplate: OwnerAgentTemplate;
}

/** The production table. `agentTemplate` comes from the Owner's settings template. */
export function studentRoutePolicy(agentTemplate: OwnerAgentTemplate = {}): RoutePolicy {
	return { rules: STUDENT_ROUTES, blockedPages: BLOCKED_PAGES, agentTemplate };
}

export const MAX_CHECKED_BODY_BYTES = 64 * 1024;

export type GuardVerdict =
	| { kind: "pass"; body?: Buffer }
	| { kind: "refuse"; status: number; message: string }
	| { kind: "redirect-home" };

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** Structural equality for JSON values (key order does not matter). */
export function sameJson(a: unknown, b: unknown): boolean {
	if (a === b) return true;
	if (Array.isArray(a) || Array.isArray(b)) {
		if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
		return a.every((item, i) => sameJson(item, b[i]));
	}
	if (isObject(a) && isObject(b)) {
		const keys = Object.keys(a).filter((k) => a[k] !== undefined);
		const otherKeys = Object.keys(b).filter((k) => b[k] !== undefined);
		if (keys.length !== otherKeys.length) return false;
		return keys.every((k) => Object.hasOwn(b, k) && sameJson(a[k], b[k]));
	}
	return false;
}

/** An absent value and an empty object both mean "no per-role models". */
const noModels = (value: unknown) => value === undefined || (isObject(value) && Object.keys(value).length === 0);

export const OWNER_SETTING_MESSAGE = "North Aero sets the AI models and file access. They can't be changed here.";

/** Checks one agent-section body against the template. Null means it may pass. */
export function agentSettingsProblem(body: unknown, template: OwnerAgentTemplate): string | null {
	if (!isObject(body)) return "Invalid JSON body";
	const modelsOk = noModels(template.models) ? noModels(body.models) : sameJson(body.models, template.models);
	if (!modelsOk || !sameJson(body.fileAccess, template.fileAccess)) return OWNER_SETTING_MESSAGE;
	return null;
}

function readBody(req: IncomingMessage, limit: number): Promise<Buffer | null> {
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		let size = 0;
		let done = false;
		req.on("data", (chunk: Buffer) => {
			if (done) return;
			size += chunk.length;
			if (size > limit) {
				done = true;
				resolve(null);
				req.resume();
				return;
			}
			chunks.push(chunk);
		});
		req.on("end", () => {
			if (!done) resolve(Buffer.concat(chunks));
		});
		req.on("error", reject);
	});
}

export async function guardRoute(req: IncomingMessage, pathname: string, policy: RoutePolicy): Promise<GuardVerdict> {
	const decision = decideRoute(req.method ?? "GET", pathname, policy.rules, policy.blockedPages);
	if (decision.kind === "pass") return { kind: "pass" };
	if (decision.kind === "redirect-home") return decision;
	if (decision.kind === "refuse") return { kind: "refuse", status: decision.status, message: decision.message };

	const body = await readBody(req, MAX_CHECKED_BODY_BYTES);
	if (!body) return { kind: "refuse", status: 413, message: "Request too large." };
	let parsed: unknown;
	try {
		parsed = JSON.parse(new TextDecoder("utf-8").decode(body));
	} catch {
		return { kind: "refuse", status: 400, message: "Invalid JSON body" };
	}
	const problem = agentSettingsProblem(parsed, policy.agentTemplate);
	if (problem === "Invalid JSON body") return { kind: "refuse", status: 400, message: problem };
	if (problem) return { kind: "refuse", status: 403, message: problem };
	return { kind: "pass", body };
}
