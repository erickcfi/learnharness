/**
 * The front door with every Wave 1 piece wired in (W1-6; PRD section 8,
 * docs/plan.md "Security comes first"). server.ts calls startFrontDoor()
 * with Next.js's handler for the /account pages; the end-to-end test calls
 * it with stand-ins for Clerk and those pages.
 *
 * What it connects:
 *  - Start checks (wiring/env.ts): lockdown's production safety check and
 *    the secrets this file needs.
 *  - The database (frontdoor/db): accounts and tenants (SupabaseAccountStore),
 *    markTenantReady after provisioning, and the meter's store. With no
 *    SUPABASE_DB_URL outside production, both stores stay in memory.
 *  - Lockdown: each tenant's settings.json gets the library-only File access
 *    section, each tenant server gets LH_LIBRARY_DIR and runs with the log
 *    filter (`node --import log-hygiene/preload.ts`). What a tenant prints
 *    to stderr reaches this log filtered and capped; stdout is dropped
 *    (wiring/tenant-logs.ts).
 *  - Metering: the meter listens on 127.0.0.1 on a free port. Each tenant
 *    server gets its pass key and the meter's address, never a real key.
 *    The real Anthropic and Tavily keys stay in this process.
 *  - Email reports (W2-10, reports/wiring.ts): the report loop and the
 *    /account/reports and /account/unsubscribe pages. The SES keys stay in
 *    this process too.
 *
 * Tenant servers still get only the supervisor's short allowlist from this
 * process's environment, plus the two sections above (tenants/supervisor.ts).
 */
import * as fs from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { BILLING_OFF_WARNING, billingOff, loadBillingConfig } from "../billing/config.ts";
import { clerkEmailLookup, type EmailLookup } from "../billing/clerk-email.ts";
import { createBillingCore, siteUrlFrom } from "../billing/core.ts";
import { type BillingGatewayHook, createBillingHook, createBillingOffHook } from "../billing/gateway-hook.ts";
import { databaseRetention, type RetentionHooks } from "../billing/hooks.ts";
import { createStripeClient, type StripeApi } from "../billing/stripe-api.ts";
import { createDashboard } from "../admin/wiring.ts";
import { type Db, markTenantReady } from "../db/index.ts";
import type { EmailSender } from "../email/sender.ts";
import type { ClerkGateway } from "../gateway/auth.ts";
import { createClerkGateway } from "../gateway/clerk.ts";
import { createGateway } from "../gateway/handler.ts";
import { studentRoutePolicy } from "../gateway/route-guard.ts";
import type { RouteRule } from "../gateway/route-policy.ts";
import { passKeyResolver } from "../metering/pass-key.ts";
import { createMeteringProxy } from "../metering/proxy.ts";
import { createMemoryMeteringStore } from "../metering/store.ts";
import { createSupabaseMeteringStore, type DurableMeteringStore } from "../metering/supabase-store.ts";
import { meteringEnvForTenant } from "../metering/tenant-env.ts";
import { createDataSafety, type DataSafety } from "../pause/data-safety.ts";
import { tenantServerEnv } from "../production-safety/index.ts";
import { endedSittingsSource } from "../study-time/queries.ts";
import { type EmailReports, type EmailReportsOptions, startEmailReports } from "../reports/wiring.ts";
import { fileAccessTemplate, libraryDir, tenantLockdownEnv } from "../settings-template/file-access.ts";
import { type AccountStore, InMemoryAccountStore } from "../tenants/accounts.ts";
import { provisionTenant } from "../tenants/provisioning.ts";
import type { FileAccessProvider } from "../tenants/settings-template.ts";
import { SupabaseAccountStore } from "../tenants/supabase-accounts.ts";
import { type TenantEndpoint, TenantSupervisor } from "../tenants/supervisor.ts";
import { connectDatabase, type DatabaseConnection } from "./database.ts";
import { preflight } from "./env.ts";
import { tenantStderrForwarder } from "./tenant-logs.ts";

/** Loaded into every tenant server with --import (lockdown, cross-cutting req 3). */
export const LOG_FILTER_MODULE = fileURLToPath(new URL("../log-hygiene/preload.ts", import.meta.url));

/** Usage rows the database could not take before a shutdown, written at the next start. */
export const pendingUsageFile = (volumeDir: string) => path.join(volumeDir, "metering", "pending-usage.jsonl");

export interface FrontDoorOptions {
	env: Readonly<Record<string, string | undefined>>;
	/** The front door's own pages under /account (Next.js in server.ts). */
	frontDoorApp(req: IncomingMessage, res: ServerResponse): unknown;
	/** Default: Clerk, from the config. Tests pass a stand-in. */
	clerk?: ClerkGateway;
	/** Default: a client for SUPABASE_DB_URL. Tests pass PGlite. Not closed by close(). */
	db?: Db;
	/** Tests only: where the meter forwards (fakes on 127.0.0.1). Never set from the environment. */
	upstream?: { anthropicBaseUrl?: string; tavilyBaseUrl?: string };
	/** Tests only: extra API routes a stand-in tenant answers (W2-6 route table).
	 *  Never set from the environment. */
	extraTestRoutes?: readonly RouteRule[];
	/** Tests only: the email sender and student directory for the reports (W2-10). */
	email?: Pick<EmailReportsOptions, "sender" | "students">;
	/** W2-8. Default: Stripe's client for STRIPE_SECRET_KEY. Tests pass the stand-in (billing/testing.ts). */
	stripe?: StripeApi;
	/** W2-8. Default: Clerk's primary email for the user. */
	emailLookup?: EmailLookup;
	/** W2-8. Default: the report emails' sender (W2-10), so billing email uses the same SES identity. */
	billingEmail?: EmailSender | null;
	/** W2-8. Default: the database's retention calls. The master wires w2-pause's startRetention. */
	retention?: RetentionHooks;
	/** Operational lines. Never given session text or email addresses. */
	log?: (line: string) => void;
}

export interface FrontDoor {
	/** Where the front door listens, for example http://127.0.0.1:3000. */
	url: string;
	/** Where tenant servers reach the meter. */
	meterUrl: string;
	/** A tenant's server (started if needed) and the secret header every
	 *  request to it needs (W2-6 wall A). For records, dashboard, email. */
	tenantEndpoint(tenantId: string): Promise<TenantEndpoint>;
	/** W2-7, with a database: pause controls (dashboard), retention calls (Stripe), the cost watch. */
	dataSafety?: DataSafety;
	/** Email reports (W2-10). */
	email: Pick<EmailReports, "mode" | "sender" | "runner">;
	/** Stops tenant servers, writes every usage row it still holds, and closes. */
	close(): Promise<void>;
}

function listen(server: Server, port: number, host: string): Promise<number> {
	return new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(port, host, () => {
			server.off("error", reject);
			resolve((server.address() as AddressInfo).port);
		});
	});
}

function closeServer(server: Server): Promise<void> {
	return new Promise((resolve) => {
		server.close(() => resolve());
		server.closeAllConnections();
	});
}

const urlHost = (host: string) => (host.includes(":") ? `[${host}]` : host);

export async function startFrontDoor(options: FrontDoorOptions): Promise<FrontDoor> {
	const { config, wiring } = preflight(options.env);
	const log = options.log ?? ((line: string) => console.log(`[frontdoor] ${line}`));
	if (!wiring.production && wiring.missing.length > 0) log(`not set (allowed outside production): ${wiring.missing.join(", ")}`);

	// The database: accounts, tenants and usage. In memory only outside production.
	let connection: DatabaseConnection | undefined;
	if (!options.db && wiring.supabaseDbUrl) connection = connectDatabase(wiring.supabaseDbUrl, { production: wiring.production });
	const db = options.db ?? connection?.db;
	const accounts: AccountStore = db ? new SupabaseAccountStore(db) : new InMemoryAccountStore();
	const meteringStore: DurableMeteringStore = db
		? createSupabaseMeteringStore(db, { log, pendingFile: pendingUsageFile(config.volumeDir) })
		: { ...createMemoryMeteringStore(), flush: async () => {}, close: async () => {}, pending: () => 0 };
	if (!db) log("no database: accounts and usage are kept in memory until the front door stops");
	const clerk = options.clerk ?? createClerkGateway(config.clerk);
	// W2-7 (pause/data-safety.ts): alert and autopause after each call, retention refusal, screens, export, jobs. Needs the database.
	const safety = db
		? createDataSafety({
				db,
				volumeDir: config.volumeDir,
				log,
				secureCookies: config.secureCookies,
				...(clerk.deleteUser ? { deleteLogin: (id: string) => clerk.deleteUser!(id) } : {}),
			})
		: undefined;

	// Lockdown: the shared library is the only folder a tenant's file tools may read.
	const library = libraryDir(config.volumeDir);
	fs.mkdirSync(library, { recursive: true });
	const libraryOnly: FileAccessProvider = () => fileAccessTemplate(library);

	// Metering: on 127.0.0.1 only, on a free port.
	const meter = createMeteringProxy({
		store: safety ? safety.wrapMeterStore(meteringStore) : meteringStore,
		resolveTenant: passKeyResolver(wiring.passKeySecret),
		anthropic: { apiKey: wiring.anthropicApiKey, ...(options.upstream?.anthropicBaseUrl ? { baseUrl: options.upstream.anthropicBaseUrl } : {}) },
		...(wiring.tavilyApiKey
			? { tavily: { apiKey: wiring.tavilyApiKey, ...(options.upstream?.tavilyBaseUrl ? { baseUrl: options.upstream.tavilyBaseUrl } : {}) } }
			: {}),
		log,
	});
	const meterServer = createServer(meter.handle);
	const meterPort = await listen(meterServer, 0, "127.0.0.1");
	const meterUrl = `http://127.0.0.1:${meterPort}`;

	const supervisor = new TenantSupervisor({
		serverScript: config.tenantServerScript,
		volumeDir: config.volumeDir,
		baseEnv: options.env,
		nodeArgs: ["--import", LOG_FILTER_MODULE],
		// Metering last. tenantServerEnv() drops any variable production safety blocks.
		extraEnv: (tenantId) =>
			tenantServerEnv({}, { ...tenantLockdownEnv(library), ...meteringEnvForTenant(tenantId, { passKeySecret: wiring.passKeySecret, proxyUrl: meterUrl }) }),
		// Errors only, filtered, cut, and capped per tenant (wiring/tenant-logs.ts).
		onOutput: tenantStderrForwarder({ log }),
		onExit: (tenantId, code, signal) => log(`tenant ${tenantId} server stopped (code ${code}, signal ${signal})`),
		// W2-6, P2-04: the Owner's template is written again before every start.
		prepare: (tenantId) => {
			provisionTenant({ volumeDir: config.volumeDir, tenantId, fileAccess: libraryOnly });
		},
	});
	// W2-6: the route table, with the Owner's File access for the agent-section check.
	const policy = studentRoutePolicy({ fileAccess: fileAccessTemplate(library) });
	const routePolicy = options.extraTestRoutes ? { ...policy, rules: [...options.extraTestRoutes, ...policy.rules] } : policy;
	const dataSafety = safety?.attach(supervisor);

	// W2-9: the Owner's dashboard at /admin, study time (PD1), the non-aviation flag (admin/wiring.ts).
	const dashboard = createDashboard({
		db: db ?? null,
		sessionSecret: config.sessionSecret,
		clerk,
		secureCookies: config.secureCookies,
		trustForwardedHeaders: config.trustForwardedHeaders,
		frontDoorApp: options.frontDoorApp,
		supervisor,
		// W2-6 wall A: topics, session text and the N7 sweep read tenants with their secret.
		tenantFetch: (tenantId, path) => supervisor.tenantFetch(tenantId, path),
		// W2-7: the real pause and unpause (fresh count after unpause, alert cleared).
		...(safety ? { pause: safety.controls } : {}),
		libraryDir: library,
		clerkSecretKey: config.clerk.secretKey || undefined,
		anthropic: { apiKey: wiring.anthropicApiKey, ...(options.upstream?.anthropicBaseUrl ? { baseUrl: options.upstream.anthropicBaseUrl } : {}) },
		// N7, approved by the master 2026-11-08: Haiku labels each ended chat from its title and plan topics only.
		labelTopics: true,
		log,
	});

	// Email reports (W2-10): the report loop and the report pages.
	const email = startEmailReports({
		env: options.env,
		db: db ?? null,
		accounts,
		clerk,
		clerkSettings: config.clerk,
		sessionSecret: config.sessionSecret,
		secureCookies: config.secureCookies,
		trustForwardedHeaders: config.trustForwardedHeaders,
		// W2-6 wall A: every read of a tenant's server carries that tenant's secret.
		tenantFetch: (tenantId, path, init) => supervisor.tenantFetch(tenantId, path, init),
		// The one 30-minute rule (frontdoor/study-time): ended study sittings with per-chat seconds.
		...(db ? { sittings: endedSittingsSource(db) } : {}),
		...options.email,
		log,
	});

	// Billing (W2-8): Stripe, the plans screen and the trial gate. Off with
	// FRONTDOOR_BILLING=off, or (outside production only) with no Stripe
	// settings or no database; production refuses to start without them.
	const billingConfig = loadBillingConfig(options.env);
	let billing: BillingGatewayHook;
	if (billingConfig && db) {
		const core = createBillingCore({
			db,
			stripe: options.stripe ?? createStripeClient(billingConfig.secretKey),
			// W2-7: the real retention (90-day hold, plan-ended screen, day-91 delete) when the data-safety layer is attached.
			retention: options.retention ?? dataSafety?.retention ?? databaseRetention(db),
			// The report emails' sender (SES in production when set up). None: each skipped billing email is logged.
			email: options.billingEmail !== undefined ? options.billingEmail : email.sender,
			webhookSecret: billingConfig.webhookSecret,
			siteUrl: siteUrlFrom(options.env),
			log,
		});
		billing = createBillingHook(core, { emailFor: options.emailLookup ?? clerkEmailLookup(config.clerk.secretKey) });
	} else {
		billing = createBillingOffHook();
		log(billingOff(options.env) ? BILLING_OFF_WARNING : "billing not configured (no Stripe settings or no database): no plans screen, no trial gate");
	}

	const gateway = createGateway({
		accounts,
		clerk,
		billing,
		admin: dashboard.admin,
		studentRoutes: dashboard.studentRoutes,
		supervisor,
		routePolicy,
		provision: async (tenantId) => {
			provisionTenant({ volumeDir: config.volumeDir, tenantId, fileAccess: libraryOnly });
			// Safe to repeat: only a tenant still in 'provisioning' changes.
			if (db) await markTenantReady(db, tenantId);
		},
		sessionSecret: config.sessionSecret,
		secureCookies: config.secureCookies,
		trustForwardedHeaders: config.trustForwardedHeaders,
		frontDoorApp: options.frontDoorApp,
		...(dataSafety ? { tenantGate: dataSafety.gate } : {}),
		reportPages: email.reportPages,
		log,
	});

	const server = createServer(gateway);
	const port = await listen(server, config.port, config.listenHost);
	const url = `http://${urlHost(config.listenHost === "0.0.0.0" ? "127.0.0.1" : config.listenHost)}:${port}`;
	log(`listening on ${config.listenHost}:${port}; meter on 127.0.0.1:${meterPort}`);

	let closing: Promise<void> | undefined;
	return {
		url,
		meterUrl,
		tenantEndpoint: (tenantId) => supervisor.endpoint(tenantId),
		...(safety ? { dataSafety: safety } : {}),
		email: { mode: email.mode, sender: email.sender, runner: email.runner },
		close() {
			closing ??= (async () => {
				await safety?.close();
				const stopped = closeServer(server);
				await dashboard.close();
				await email.close();
				await supervisor.stopAll();
				await stopped;
				// Every usage write already started, then every row still waiting.
				await meter.flush();
				await closeServer(meterServer);
				await meteringStore.close();
				await connection?.close();
			})();
			return closing;
		},
	};
}
