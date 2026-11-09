/**
 * Billing at the front door (W2-8): what gateway/handler.ts calls.
 *
 *  POST /account/stripe/webhook   Stripe's events. No login: the Stripe signature is the check.
 *  GET  /account/billing/state    the plans screen's data (BillingView)
 *  POST /account/billing/checkout plan=…            → Stripe Checkout
 *  POST /account/billing/buy-now  plan=…&agree=yes  → ends the trial, charges now
 *  POST /account/billing/portal                     → Stripe's customer portal
 * The /account/billing routes sit behind the same login check as the tutor
 * (fd_session and the 5-minute Clerk re-check); handler.ts sends them there.
 *
 * The trial gate (P4-03, C2 req 3), on every logged-in tutor request:
 *  - no plan: every tutor page goes to the plans screen; /api writes get 402.
 *  - trial used up, or plan ended: requests that start model work get 402
 *    with a sentence naming the plans screen (upstream shows it as the turn's
 *    error); opening New chat goes to the plans screen. Every page and read
 *    still works, so all chats and records stay readable.
 *  - open: nothing changes.
 * If the database cannot answer, the gate lets the request through: the
 * meter refuses model calls it cannot account for (metering/supabase-store.ts).
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { normalizeEmailAddress } from "../email/address.ts";
import { type Access } from "./access.ts";
import { billingState, buyNow, openPortal, startCheckout, type ActionResult } from "./actions.ts";
import { isPlanId } from "./catalog.ts";
import { BILLING_PREFIX, PLANS_PATH, WEBHOOK_PATH } from "./config.ts";
import { REFUSALS } from "./copy.ts";
import type { BillingCore } from "./core.ts";
import { type BillingView, noticeFromQuery } from "./view.ts";
import { receiveWebhook } from "./webhook.ts";

export interface BillingRequestContext {
	tenantId: string;
	/** Clerk user id, for the student's email. */
	userId: string;
	pathname: string;
	/** Path and query string. */
	target: string;
	/** This site's origin, for example https://ground.flynorthaero.com. */
	origin: string;
	/** Cookies the gateway must still set (a renewed login cookie). */
	setCookie: string[];
}

/** What gateway/handler.ts needs from billing. */
export interface BillingGatewayHook {
	webhookPath: string;
	/** True for /account/billing/…, which handler.ts routes through the login check. */
	owns(pathname: string): boolean;
	/** POST /account/stripe/webhook. */
	webhook(req: IncomingMessage, res: ServerResponse): Promise<void>;
	/** A logged-in request: answers it and returns true, or returns false to let it pass. */
	handle(req: IncomingMessage, res: ServerResponse, ctx: BillingRequestContext): Promise<boolean>;
}

/** Requests that start model work (upstream routes at 713377f): refused while the trial is used up. */
const TURN_ROUTES: readonly RegExp[] = [/^\/api\/chat$/, /^\/api\/chats$/, /^\/api\/chats\/[^/]+\/steer$/, /^\/api\/graph\/import$/, /^\/api\/graph\/coverage\/extract$/];

export const isTurnRequest = (method: string | undefined, pathname: string) => method === "POST" && TURN_ROUTES.some((r) => r.test(pathname));

const NEW_CHAT_PATH = "/chat/new";
const MAX_FORM_BYTES = 4096;
const MAX_WEBHOOK_BYTES = 1024 * 1024;

const isApi = (pathname: string) => pathname === "/api" || pathname.startsWith("/api/");
const isRead = (req: IncomingMessage) => req.method === "GET" || req.method === "HEAD";
/** A tutor page, not a built file: no /_next/ and no file extension. */
const isPage = (pathname: string) => !isApi(pathname) && !pathname.startsWith("/_next/") && !/\.[A-Za-z0-9]+$/.test(pathname);

function readBody(req: IncomingMessage, limit: number): Promise<Buffer | null> {
	return new Promise((resolve, reject) => {
		let size = 0;
		const chunks: Buffer[] = [];
		req.on("data", (chunk: Buffer) => {
			size += chunk.length;
			if (size > limit) {
				resolve(null);
				req.destroy();
				return;
			}
			chunks.push(chunk);
		});
		req.on("end", () => resolve(Buffer.concat(chunks)));
		req.on("error", reject);
	});
}

function send(res: ServerResponse, status: number, headers: Record<string, string | string[]>, body = ""): void {
	res.writeHead(status, { "Cache-Control": "no-store", ...headers });
	res.end(body);
}

const json = (res: ServerResponse, status: number, body: object, setCookie: string[] = []) =>
	send(res, status, { "Content-Type": "application/json", ...(setCookie.length ? { "Set-Cookie": setCookie } : {}) }, JSON.stringify(body));

const redirect = (res: ServerResponse, status: number, location: string, setCookie: string[] = []) => send(res, status, { Location: location, ...(setCookie.length ? { "Set-Cookie": setCookie } : {}) });

/** The sentence a refused request carries (upstream shows it as "Something went wrong: …"). */
export function refusalMessage(access: Access, origin: string): string {
	const plans = `${origin}${PLANS_PATH}`;
	switch (access.state) {
		case "trial-used":
			return REFUSALS.trialUsed(plans);
		case "ended":
			return access.subscription?.status === "unpaid" || access.subscription?.status === "paused" ? REFUSALS.unpaid(plans) : REFUSALS.planEnded(plans);
		default:
			return REFUSALS.noPlan(plans);
	}
}

export interface BillingHookOptions {
	/** The student's email from Clerk (for the trial check and the Stripe customer). Null if unknown. */
	emailFor(userId: string): Promise<string | null>;
}

export function createBillingHook(core: BillingCore, options: BillingHookOptions): BillingGatewayHook {
	async function accessOrNull(tenantId: string): Promise<Access | null> {
		try {
			return await core.access.get(tenantId);
		} catch (error) {
			core.log(`billing check failed for tenant ${tenantId}; request let through: ${(error as Error).message}`);
			return null;
		}
	}

	function finish(res: ServerResponse, result: ActionResult, setCookie: string[]): void {
		if ("redirect" in result) return redirect(res, 303, result.redirect, setCookie);
		redirect(res, 303, `${PLANS_PATH}?error=${result.error === "bad-plan" ? "unavailable" : result.error}`, setCookie);
	}

	async function billingRoute(req: IncomingMessage, res: ServerResponse, ctx: BillingRequestContext): Promise<void> {
		const action = ctx.pathname.slice(BILLING_PREFIX.length + 1);
		const url = new URL(`http://front.door${ctx.target}`);
		if (action === "state" && isRead(req)) {
			const email = normalizeEmailAddress(await options.emailFor(ctx.userId).catch(() => null));
			const view = await billingState(core, {
				tenantId: ctx.tenantId,
				email,
				checkoutSessionId: url.searchParams.get("checkout"),
				notice: noticeFromQuery({ error: url.searchParams.get("error"), checkout: url.searchParams.get("checkout") }),
				bought: url.searchParams.get("bought"),
			});
			return json(res, 200, view, ctx.setCookie);
		}
		if (req.method !== "POST" || !["checkout", "buy-now", "portal"].includes(action)) return json(res, 404, { error: "Not found." }, ctx.setCookie);
		// Forms come only from this site (the login cookie is SameSite=Lax too).
		const origin = req.headers.origin;
		if (origin && origin !== ctx.origin) return json(res, 403, { error: "Forbidden." }, ctx.setCookie);
		const raw = await readBody(req, MAX_FORM_BYTES);
		if (!raw) return json(res, 413, { error: "Form too large." }, ctx.setCookie);
		const form = new URLSearchParams(raw.toString("utf8"));
		const plan = form.get("plan");

		try {
			if (action === "portal") return finish(res, await openPortal(core, { tenantId: ctx.tenantId, origin: ctx.origin }), ctx.setCookie);
			if (!isPlanId(plan)) return finish(res, { error: "bad-plan" }, ctx.setCookie);
			if (action === "buy-now") return finish(res, await buyNow(core, { tenantId: ctx.tenantId, planId: plan, agreed: form.get("agree") === "yes" }), ctx.setCookie);
			const email = normalizeEmailAddress(await options.emailFor(ctx.userId).catch(() => null));
			if (!email) return finish(res, { error: "unavailable" }, ctx.setCookie);
			return finish(res, await startCheckout(core, { tenantId: ctx.tenantId, email, planId: plan, origin: ctx.origin }), ctx.setCookie);
		} catch (error) {
			core.log(`billing ${action} failed for tenant ${ctx.tenantId}: ${(error as Error).message}`);
			return finish(res, { error: "unavailable" }, ctx.setCookie);
		}
	}

	return {
		webhookPath: WEBHOOK_PATH,
		owns: (pathname) => pathname.startsWith(`${BILLING_PREFIX}/`),

		async webhook(req, res) {
			const raw = await readBody(req, MAX_WEBHOOK_BYTES);
			if (!raw) return json(res, 413, { error: "Too large." });
			const signature = req.headers["stripe-signature"];
			const result = await receiveWebhook(core, raw, Array.isArray(signature) ? signature[0] : signature);
			json(res, result.status, result.body);
		},

		async handle(req, res, ctx) {
			if (ctx.pathname.startsWith(`${BILLING_PREFIX}/`)) {
				await billingRoute(req, res, ctx);
				return true;
			}
			const page = isRead(req) && isPage(ctx.pathname);
			const turn = isTurnRequest(req.method, ctx.pathname);
			const apiWrite = isApi(ctx.pathname) && !isRead(req);
			if (!page && !turn && !apiWrite) return false;

			const access = await accessOrNull(ctx.tenantId);
			if (!access || access.state === "open") return false;
			if (page) {
				if (access.state === "no-plan") {
					redirect(res, 302, PLANS_PATH, ctx.setCookie);
					return true;
				}
				if (ctx.pathname === NEW_CHAT_PATH) {
					redirect(res, 302, `${PLANS_PATH}?reason=${access.state}`, ctx.setCookie);
					return true;
				}
				return false;
			}
			if (turn) {
				// Plain text: upstream's chat client shows the body as the error (components/session-core.ts).
				send(res, 402, { "Content-Type": "text/plain; charset=utf-8", ...(ctx.setCookie.length ? { "Set-Cookie": ctx.setCookie } : {}) }, refusalMessage(access, ctx.origin));
				return true;
			}
			if (access.state === "no-plan") {
				json(res, 402, { error: refusalMessage(access, ctx.origin) }, ctx.setCookie);
				return true;
			}
			return false;
		},
	};
}

/** FRONTDOOR_BILLING=off (or no Stripe outside production): no gate; the plans screen says plans are not available. */
export function createBillingOffHook(): BillingGatewayHook {
	const off: BillingView = { billing: "off" };
	return {
		webhookPath: WEBHOOK_PATH,
		owns: (pathname) => pathname.startsWith(`${BILLING_PREFIX}/`),
		async webhook(_req, res) {
			json(res, 404, { error: "Billing is off." });
		},
		async handle(req, res, ctx) {
			if (!ctx.pathname.startsWith(`${BILLING_PREFIX}/`)) return false;
			if (ctx.pathname === `${BILLING_PREFIX}/state` && isRead(req)) json(res, 200, off, ctx.setCookie);
			else json(res, 503, { error: "Billing is not set up yet." }, ctx.setCookie);
			return true;
		},
	};
}
