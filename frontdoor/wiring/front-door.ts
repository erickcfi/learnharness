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
 *
 * Tenant servers still get only the supervisor's short allowlist from this
 * process's environment, plus the two sections above (tenants/supervisor.ts).
 */
import * as fs from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { type Db, markTenantReady } from "../db/index.ts";
import type { ClerkGateway } from "../gateway/auth.ts";
import { createClerkGateway } from "../gateway/clerk.ts";
import { createGateway } from "../gateway/handler.ts";
import { passKeyResolver } from "../metering/pass-key.ts";
import { createMeteringProxy } from "../metering/proxy.ts";
import { createMemoryMeteringStore } from "../metering/store.ts";
import { createSupabaseMeteringStore, type DurableMeteringStore } from "../metering/supabase-store.ts";
import { meteringEnvForTenant } from "../metering/tenant-env.ts";
import { createDataSafety, type DataSafety } from "../pause/data-safety.ts";
import { tenantServerEnv } from "../production-safety/index.ts";
import { fileAccessTemplate, libraryDir, tenantLockdownEnv } from "../settings-template/file-access.ts";
import { type AccountStore, InMemoryAccountStore } from "../tenants/accounts.ts";
import { provisionTenant } from "../tenants/provisioning.ts";
import type { FileAccessProvider } from "../tenants/settings-template.ts";
import { SupabaseAccountStore } from "../tenants/supabase-accounts.ts";
import { TenantSupervisor } from "../tenants/supervisor.ts";
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
	/** Operational lines. Never given session text or email addresses. */
	log?: (line: string) => void;
}

export interface FrontDoor {
	/** Where the front door listens, for example http://127.0.0.1:3000. */
	url: string;
	/** Where tenant servers reach the meter. */
	meterUrl: string;
	/** W2-7, with a database: pause controls (dashboard), retention calls (Stripe), the cost watch. */
	dataSafety?: DataSafety;
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
	});
	const dataSafety = safety?.attach(supervisor);

	const gateway = createGateway({
		accounts,
		clerk,
		supervisor,
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
		...(safety ? { dataSafety: safety } : {}),
		close() {
			closing ??= (async () => {
				await safety?.close();
				const stopped = closeServer(server);
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
