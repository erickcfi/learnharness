/**
 * Test harness for billing (W2-8): an in-process Postgres (PGlite) with the
 * migrations, the Stripe stand-in with the catalog set up by the real setup
 * code, the real gateway with the billing hook, and a fake tutor server.
 * Not a test file itself (no .test. in the name).
 */
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { STUDENT_COUPON_ID, TESTER_COUPON_ID, WEBHOOK_PATH } from "../frontdoor/billing/config.ts";
import { type BillingCore, createBillingCore } from "../frontdoor/billing/core.ts";
import { createBillingHook } from "../frontdoor/billing/gateway-hook.ts";
import { trialEmailHash } from "../frontdoor/billing/trial-hash.ts";
import type { RetentionHooks } from "../frontdoor/billing/hooks.ts";
import { applySetup, planSetup } from "../frontdoor/billing/setup.ts";
import { type CheckoutCompletion, type StandInOptions, StripeStandIn } from "../frontdoor/billing/testing.ts";
import type { TrialLimits } from "../frontdoor/billing/trial.ts";
import * as dbm from "../frontdoor/db/index.ts";
import { createTestDb, type TestDb } from "../frontdoor/db/testing.ts";
import { MemoryEmailSender } from "../frontdoor/email/sender.ts";
import { createGateway } from "../frontdoor/gateway/handler.ts";
import { SESSION_COOKIE, signSession } from "../frontdoor/gateway/session.ts";
import { SupabaseAccountStore } from "../frontdoor/tenants/supabase-accounts.ts";

export const WHSEC = "whsec_test_billing_harness_secret";
export const HASH_KEY = "trial-hash-key-for-tests-0123456789abcdef";
export const STUDENT_CODE = "NORTHAERO-TEST";
export const TESTER_CODE = "TESTER-standin-9f3k2";
const SECRET = new TextEncoder().encode("billing-harness-session-secret-0123456789");
const DAY = 24 * 60 * 60 * 1000;

export interface Student {
	userId: string;
	tenantId: string;
	email: string;
}

export interface Reply {
	status: number;
	location: string | null;
	contentType: string;
	text: string;
	json<T = unknown>(): T;
}

export interface Harness {
	db: dbm.Db;
	stripe: StripeStandIn;
	core: BillingCore;
	email: MemoryEmailSender;
	retentionCalls: { kind: "start" | "end"; tenantId: string; at?: Date }[];
	/** The next startRetention throws once (tests the retry). */
	retentionFailNext: boolean;
	tenantHits: { method: string; url: string; headers: IncomingHttpHeaders }[];
	base: string;
	student(name: string, email?: string): Promise<Student>;
	/** A request from the student's browser (with a fresh login cookie), or with no login. */
	request(path: string, init?: { method?: string; student?: Student; form?: Record<string, string>; headers?: Record<string, string>; body?: string }): Promise<Reply>;
	/** POST /account/billing/checkout; returns the Checkout Session id. */
	checkout(student: Student, plan?: string): Promise<string>;
	/** Delivers every pending Stripe event (and those they cause), signed, to the webhook. */
	deliverAll(): Promise<number[]>;
	/** Checkout through to a delivered subscription. */
	subscribe(student: Student, opts?: { plan?: string; card?: CheckoutCompletion["card"]; promotionCode?: string }): Promise<{ sessionId: string; subscriptionId: string }>;
	addStudy(student: Student, seconds: number, hoursAfterNow?: number): Promise<void>;
	addCost(student: Student, usd: number): Promise<void>;
	days(n: number): Promise<void>;
	close(): Promise<void>;
}

export async function startHarness(options: { standIn?: Partial<StandInOptions>; limits?: TrialLimits; setupCodes?: boolean } = {}): Promise<Harness> {
	const t: TestDb = await createTestDb();
	const stripe = new StripeStandIn({ webhookSecret: WHSEC, upcomingRenewalDays: 30, ...options.standIn });
	const codes = options.setupCodes === false ? {} : { [STUDENT_COUPON_ID]: STUDENT_CODE, [TESTER_COUPON_ID]: TESTER_CODE };
	await applySetup(stripe, await planSetup(stripe, { codes }));
	stripe.takeEvents();
	stripe.calls.length = 0;

	const email = new MemoryEmailSender();
	const retentionCalls: Harness["retentionCalls"] = [];
	// Like w2-pause's retention(): its own database handle, so it must run after the webhook's transaction.
	const retention: RetentionHooks = {
		async startRetention(tenantId, at) {
			if (h.retentionFailNext) {
				h.retentionFailNext = false;
				throw new Error("stand-in retention failure");
			}
			retentionCalls.push({ kind: "start", tenantId, at });
			return dbm.startRetention(t.db, tenantId, at);
		},
		async endRetention(tenantId) {
			retentionCalls.push({ kind: "end", tenantId });
			return dbm.endRetention(t.db, tenantId);
		},
	};
	const core = createBillingCore({
		db: t.db,
		stripe,
		retention,
		email,
		webhookSecret: WHSEC,
		hashEmail: (address) => trialEmailHash(address, { LH_TRIAL_HASH_KEY: HASH_KEY }),
		siteUrl: "https://ground.test",
		now: () => stripe.now(),
		accessTtlMs: 0,
		...(options.limits ? { limits: options.limits } : {}),
	});
	const emails = new Map<string, string>();
	const hook = createBillingHook(core, { emailFor: async (userId) => emails.get(userId) ?? null });

	const tenantHits: Harness["tenantHits"] = [];
	const tenant: Server = createServer((req, res) => {
		tenantHits.push({ method: req.method ?? "", url: req.url ?? "", headers: req.headers });
		req.resume();
		req.on("end", () => {
			res.setHeader("Content-Type", "text/plain");
			res.end("from tenant");
		});
	});
	await new Promise<void>((r) => tenant.listen(0, "127.0.0.1", r));
	const tenantPort = (tenant.address() as AddressInfo).port;

	const accounts = new SupabaseAccountStore(t.db);
	const handler = createGateway({
		accounts,
		clerk: { authenticate: async () => ({ status: "signed-out" }), isSessionActive: async () => true },
		supervisor: { ensureRunning: async () => tenantPort },
		provision: async () => {},
		sessionSecret: SECRET,
		secureCookies: false,
		trustForwardedHeaders: false,
		frontDoorApp: (req, res) => {
			res.setHeader("X-Front-Door-App", "1");
			res.end(`front door page ${req.url}`);
		},
		now: () => stripe.now(),
		billing: hook,
	});
	const gateway = createServer(handler);
	await new Promise<void>((r) => gateway.listen(0, "127.0.0.1", r));
	const base = `http://127.0.0.1:${(gateway.address() as AddressInfo).port}`;

	let n = 0;
	const h: Harness = {
		db: t.db,
		stripe,
		core,
		email,
		retentionCalls,
		retentionFailNext: false,
		tenantHits,
		base,
		async student(name, address = `${name}@example.com`) {
			const userId = `user_${name}_${++n}`;
			await accounts.confirmAge(userId, new Date(stripe.now()));
			const tenantId = await accounts.assignTenant(userId);
			await dbm.markTenantReady(t.db, tenantId);
			emails.set(userId, address);
			return { userId, tenantId, email: address };
		},
		async request(path, init = {}) {
			const headers: Record<string, string> = { ...init.headers };
			if (init.student) {
				const token = await signSession({ userId: init.student.userId, sessionId: `sess_${init.student.userId}`, tenantId: init.student.tenantId, checkedAt: stripe.now() }, SECRET, stripe.now());
				headers.cookie = `${SESSION_COOKIE}=${token}`;
			}
			let body = init.body;
			if (init.form) {
				body = new URLSearchParams(init.form).toString();
				headers["content-type"] = "application/x-www-form-urlencoded";
			}
			const res = await fetch(`${base}${path}`, { method: init.method ?? (body !== undefined ? "POST" : "GET"), headers, body, redirect: "manual" });
			const text = await res.text();
			return { status: res.status, location: res.headers.get("location"), contentType: res.headers.get("content-type") ?? "", text, json: <T>() => JSON.parse(text) as T };
		},
		async checkout(student, plan = "monthly") {
			const res = await h.request("/account/billing/checkout", { student, form: { plan } });
			if (res.status !== 303 || !res.location?.startsWith("https://checkout.stripe.test/")) throw new Error(`checkout did not redirect to Stripe: ${res.status} ${res.location}`);
			return res.location.split("/").pop() as string;
		},
		async deliverAll() {
			const statuses: number[] = [];
			while (stripe.pending.length > 0) statuses.push(...(await stripe.deliver(`${base}${WEBHOOK_PATH}`)));
			return statuses;
		},
		async subscribe(student, opts = {}) {
			const sessionId = await h.checkout(student, opts.plan);
			const { subscriptionId } = await stripe.completeCheckout(sessionId, { card: opts.card ?? { fingerprint: `fp_${student.userId}`, last4: "4242", brand: "visa" }, ...(opts.promotionCode ? { promotionCode: opts.promotionCode } : {}) });
			const statuses = await h.deliverAll();
			if (statuses.some((s) => s !== 200)) throw new Error(`webhook statuses ${statuses.join(",")}`);
			return { sessionId, subscriptionId };
		},
		async addStudy(student, seconds, hoursAfterNow = 0) {
			await dbm.addActiveStudyTime(t.db, { tenantId: student.tenantId, seconds, at: new Date(stripe.now() + hoursAfterNow * 3600_000), maxGapSeconds: 300 });
		},
		async addCost(student, usd) {
			await dbm.recordModelUsage(t.db, {
				tenantId: student.tenantId,
				occurredAt: new Date(stripe.now()),
				model: "claude-opus-5-5",
				inputTokens: 1000,
				outputTokens: 1000,
				cacheReadTokens: 0,
				cacheWriteTokens: 0,
				costUsd: usd,
				requestId: `req_${student.tenantId}_${Math.random()}`,
			});
		},
		async days(count) {
			stripe.advanceTo(stripe.now() + count * DAY);
			await h.deliverAll();
		},
		async close() {
			await new Promise<void>((r) => gateway.close(() => r()));
			gateway.closeAllConnections();
			await new Promise<void>((r) => tenant.close(() => r()));
			tenant.closeAllConnections();
			await t.close();
		},
	};
	return h;
}

export const cents = (usd: number) => Math.round(usd * 100);
