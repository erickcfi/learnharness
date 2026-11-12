/**
 * The front door's /course routes, for a signed-in student (master,
 * 2026-11-11). gateway/handler.ts sends them here after the login check,
 * the pause screen and the trial gate, so /course behaves like a tutor page.
 *
 *   GET  /course         the course page (Next.js, app/course/), which
 *                        checks the login and the 18+ tick again
 *   POST /course/start   leg=<id>: opens a new tutor chat for that Leg
 *
 * Starting a Leg uses upstream's own paths, unchanged:
 *  1. POST /api/chats on the student's own tutor server (with its secret
 *     header), titled with the Leg's title, as upstream's New session does.
 *  2. A row in course_leg_starts (tenant, Leg, chat, time), for the
 *     "Started" mark. Skipped quietly when the table is missing.
 *  3. A redirect to /chat/<id>?prompt=<first message>. Upstream's chat page
 *     sends ?prompt= as the chat's first message (app/chat/[id]/page.tsx,
 *     initialPrompt), once, only while the chat has no conversation yet.
 *     The longest real first message is under 1 KB in the URL.
 * The tutor then teaches its own way; its prompts and tools are unchanged.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { isSameOrigin } from "../admin/origin.ts";
import { CHAT_ID } from "../admin/tenant-api.ts";
import type { StartBlockCheck } from "./blocks.ts";
import { findLeg } from "./file.ts";
import { firstMessage } from "./first-message.ts";
import type { LegStartMarks } from "./marks.ts";
import type { CourseSource } from "./source.ts";

export const COURSE_PATH = "/course";
export const COURSE_START_PATH = "/course/start";

export type TenantRequest = (tenantId: string, path: string, init?: RequestInit) => Promise<Response>;

export interface CourseRequestContext {
	tenantId: string;
	pathname: string;
	/** Path and query string. */
	target: string;
	/** Cookies the gateway must still set (a renewed login cookie). */
	setCookie: string[];
}

export interface CourseEndpoint {
	handles(pathname: string): boolean;
	handle(req: IncomingMessage, res: ServerResponse, ctx: CourseRequestContext): Promise<void>;
}

export interface CourseEndpointDeps {
	/** The front door's Next.js handler, for app/course/. */
	frontDoorApp(req: IncomingMessage, res: ServerResponse): unknown;
	source: CourseSource;
	marks: LegStartMarks;
	startBlock: StartBlockCheck;
	/** A request to the tenant's own server, with its secret header (supervisor.tenantFetch). */
	tenantFetch: TenantRequest;
	trustForwardedHeaders: boolean;
	now?: () => number;
	log?: (line: string) => void;
}

const MAX_FORM_BYTES = 2048;
const CREATE_TIMEOUT_MS = 15_000;

function readForm(req: IncomingMessage): Promise<URLSearchParams | null> {
	return new Promise((resolve, reject) => {
		let size = 0;
		const chunks: Buffer[] = [];
		req.on("data", (chunk: Buffer) => {
			size += chunk.length;
			if (size > MAX_FORM_BYTES) {
				resolve(null);
				req.removeAllListeners("data");
				req.resume();
				return;
			}
			chunks.push(chunk);
		});
		req.on("end", () => resolve(new URLSearchParams(Buffer.concat(chunks).toString("utf8"))));
		req.on("error", reject);
	});
}

/** Where a started Leg goes: the new chat, whose first message sets up the Leg. */
export function chatStartPath(chatId: string, message: string): string {
	return `/chat/${encodeURIComponent(chatId)}?prompt=${encodeURIComponent(message)}`;
}

export function createCourseEndpoint(deps: CourseEndpointDeps): CourseEndpoint {
	const now = () => (deps.now ? deps.now() : Date.now());

	function send(res: ServerResponse, status: number, headers: Record<string, string | string[]>, body = ""): void {
		res.writeHead(status, { "Cache-Control": "no-store", ...headers });
		res.end(body);
	}
	const withCookies = (ctx: CourseRequestContext): Record<string, string[]> => (ctx.setCookie.length ? { "Set-Cookie": ctx.setCookie } : {});
	const redirect = (res: ServerResponse, ctx: CourseRequestContext, location: string) => send(res, 303, { Location: location, ...withCookies(ctx) });
	const backToCourse = (res: ServerResponse, ctx: CourseRequestContext, error?: string) => redirect(res, ctx, error ? `${COURSE_PATH}?error=${error}` : COURSE_PATH);

	/** Opens the chat on the tenant's server. Returns its id, or null. */
	async function createChat(tenantId: string, title: string): Promise<string | null> {
		try {
			const res = await deps.tenantFetch(tenantId, "/api/chats", {
				method: "POST",
				headers: { "Content-Type": "application/json", Accept: "application/json" },
				body: JSON.stringify({ title }),
				redirect: "manual",
				signal: AbortSignal.timeout(CREATE_TIMEOUT_MS),
			});
			if (!res.ok) {
				deps.log?.(`course: tenant ${tenantId} could not open a chat (status ${res.status})`);
				return null;
			}
			const body = (await res.json()) as { id?: unknown };
			if (typeof body?.id !== "string" || !CHAT_ID.test(body.id)) {
				deps.log?.(`course: tenant ${tenantId} answered without a chat id`);
				return null;
			}
			return body.id;
		} catch (error) {
			deps.log?.(`course: tenant ${tenantId} could not open a chat (${(error as Error).name})`);
			return null;
		}
	}

	async function start(req: IncomingMessage, res: ServerResponse, ctx: CourseRequestContext): Promise<void> {
		if (!isSameOrigin(req, deps.trustForwardedHeaders)) return send(res, 403, { "Content-Type": "text/plain; charset=utf-8" }, "Forbidden.");
		const form = await readForm(req);
		if (!form) return send(res, 413, { "Content-Type": "text/plain; charset=utf-8" }, "Form too large.");
		const course = await deps.source.load();
		if (!course) return backToCourse(res, ctx); // the page says the course is coming soon
		const found = findLeg(course, form.get("leg"));
		if (!found) return backToCourse(res, ctx, "no-leg");
		if (await deps.startBlock(ctx.tenantId)) {
			// Cards fallback (Erick, 2026-11-11): a paused student or one at a budget cap would get
			// pre-written question cards for this Leg here, once that mode exists. Not built yet:
			// back to /course, which says why no lesson can start.
			return backToCourse(res, ctx);
		}
		const chatId = await createChat(ctx.tenantId, found.leg.title);
		if (!chatId) return backToCourse(res, ctx, "starting");
		await deps.marks.record({ tenantId: ctx.tenantId, legId: found.leg.id, chatId, at: new Date(now()) });
		redirect(res, ctx, chatStartPath(chatId, firstMessage(found.leg)));
	}

	return {
		handles: (pathname) => pathname === COURSE_PATH || pathname.startsWith(`${COURSE_PATH}/`),
		async handle(req, res, ctx) {
			const method = req.method ?? "GET";
			if (ctx.pathname === COURSE_PATH && (method === "GET" || method === "HEAD")) {
				// Headers before Next.js starts its answer (Next.js custom-server guide).
				res.setHeader("Cache-Control", "no-store");
				if (ctx.setCookie.length) res.setHeader("Set-Cookie", ctx.setCookie);
				req.url = ctx.target;
				await deps.frontDoorApp(req, res);
				return;
			}
			if (ctx.pathname === COURSE_START_PATH && method === "POST") return start(req, res, ctx);
			if (ctx.pathname === COURSE_START_PATH) return send(res, 405, { Allow: "POST", ...withCookies(ctx) });
			send(res, 404, { "Content-Type": "text/plain; charset=utf-8", ...withCookies(ctx) }, "Not found.");
		},
	};
}
