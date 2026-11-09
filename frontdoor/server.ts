/**
 * The front door's custom Node server (PRD X5, approved 2026-11-08).
 *
 * Run: `npm run start -w frontdoor` after `npm run build` (upstream),
 * `node scripts/build-server.mjs`, and `npm run build -w frontdoor`.
 * Node runs this TypeScript file directly (type stripping), so files it
 * imports use only erasable TypeScript and `.ts` import paths.
 *
 * Next.js serves only the front door's own pages under /account. Every
 * other request goes through the gateway to the student's own LearnHarness
 * server (gateway/handler.ts).
 *
 * WIRING POINTS for the other wave 1 packages are marked below. Each is
 * filled in after its branch merges.
 */
import { createServer } from "node:http";
import next from "next";
import { createClerkGateway } from "./gateway/clerk.ts";
import { loadConfig } from "./gateway/config.ts";
import { createGateway } from "./gateway/handler.ts";
import { runStartupChecks, type StartupCheck } from "./gateway/startup-checks.ts";
import { InMemoryAccountStore } from "./tenants/accounts.ts";
import { provisionTenant } from "./tenants/provisioning.ts";
import { NO_FILE_ACCESS_SECTION } from "./tenants/settings-template.ts";
import { TenantSupervisor } from "./tenants/supervisor.ts";

// WIRING POINT (w1-lockdown): the production safety check (refuse to start
// when LH_PROVIDER_EVENTS, LH_BACKGROUND_CAPTURE or DEEPGRAM_API_KEY is set).
const STARTUP_CHECKS: StartupCheck[] = [];
runStartupChecks(process.env, STARTUP_CHECKS);

const config = loadConfig(process.env);
const log = (message: string) => console.log(`[frontdoor] ${message}`);

// WIRING POINT (w1-metering): start the meter here, on 127.0.0.1 and its own
// port, before any tenant server starts:
//   http.createServer(createMeteringProxy({ store, resolveTenant: passKeyResolver(<FRONTDOOR_PASS_KEY_SECRET>),
//     anthropic: { apiKey: <ANTHROPIC_API_KEY> }, tavily: { apiKey: <TAVILY_API_KEY> } }).handle).listen(port, "127.0.0.1")
// The real keys and the pass-key secret are front door variables only. They
// never reach a tenant: tenant servers get an allowlist (tenants/supervisor.ts).

/** Extra variables for each tenant server, from the packages that need them. */
function tenantExtraEnv(_tenantId: string): Record<string, string> {
	return {
		// WIRING POINT (w1-metering): ...meteringEnvForTenant(tenantId, { passKeySecret, proxyUrl: "http://127.0.0.1:<meter port>" }),
		// WIRING POINT (w1-lockdown): the library path variable for tenant servers.
	};
}

// No `hostname` option: Next.js then names itself "localhost" everywhere. With
// one, Clerk's middleware rewrite looked cross-origin to Next.js, which tried
// to proxy the page to itself and failed (smoke test, 2026-11-08).
const app = next({ dev: config.dev, dir: import.meta.dirname, port: config.port });
await app.prepare();
const handleNext = app.getRequestHandler();

const supervisor = new TenantSupervisor({
	serverScript: config.tenantServerScript,
	volumeDir: config.volumeDir,
	extraEnv: tenantExtraEnv,
	// WIRING POINT (w1-lockdown): nodeArgs: ["--import", <log filter module>], and onOutput.
	onExit: (tenantId, code, signal) => log(`tenant ${tenantId} server stopped (code ${code}, signal ${signal})`),
});

const gateway = createGateway({
	// WIRING POINT (w1-database): the Supabase AccountStore adapter
	// (createStudentAccount, getTenantByClerkUserId). Until then a restart
	// forgets 18+ dates, so students tick the box again.
	accounts: new InMemoryAccountStore(),
	clerk: createClerkGateway(config.clerk),
	supervisor,
	provision: (tenantId) => {
		// WIRING POINT (w1-lockdown): its FileAccessProvider in place of NO_FILE_ACCESS_SECTION (C5).
		provisionTenant({ volumeDir: config.volumeDir, tenantId, fileAccess: NO_FILE_ACCESS_SECTION });
		// WIRING POINT (w1-database): markTenantReady(db, tenantId) after the folder is written.
	},
	sessionSecret: config.sessionSecret,
	secureCookies: config.secureCookies,
	trustForwardedHeaders: config.trustForwardedHeaders,
	frontDoorApp: (req, res) => handleNext(req, res),
	log,
});

const server = createServer(gateway);
server.listen(config.port, config.listenHost, () => log(`listening on ${config.listenHost}:${config.port}`));

for (const signal of ["SIGTERM", "SIGINT"] as const) {
	process.once(signal, () => {
		log(`${signal}: stopping tenant servers`);
		server.close();
		// WIRING POINT (w1-metering): await the meter's flush() here, so no usage row is lost.
		void supervisor.stopAll().finally(() => process.exit(0));
	});
}
