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
 */
import { createServer } from "node:http";
import next from "next";
import { createClerkGateway } from "./gateway/clerk.ts";
import { loadConfig } from "./gateway/config.ts";
import { createGateway } from "./gateway/handler.ts";
import { InMemoryAccountStore } from "./tenants/accounts.ts";
import { provisionTenant } from "./tenants/provisioning.ts";
import { NO_FILE_ACCESS_SECTION } from "./tenants/settings-template.ts";
import { TenantSupervisor } from "./tenants/supervisor.ts";

const config = loadConfig(process.env);
const log = (message: string) => console.log(`[frontdoor] ${message}`);

// No `hostname` option: Next.js then names itself "localhost" everywhere. With
// one, Clerk's middleware rewrite looked cross-origin to Next.js, which tried
// to proxy the page to itself and failed (smoke test, 2026-11-08).
const app = next({ dev: config.dev, dir: import.meta.dirname, port: config.port });
await app.prepare();
const handleNext = app.getRequestHandler();

const supervisor = new TenantSupervisor({
	serverScript: config.tenantServerScript,
	volumeDir: config.volumeDir,
	onExit: (tenantId, code, signal) => log(`tenant ${tenantId} server stopped (code ${code}, signal ${signal})`),
});

const gateway = createGateway({
	// STAND-IN until w1-database's Supabase adapter: a restart forgets 18+ dates.
	accounts: new InMemoryAccountStore(),
	clerk: createClerkGateway(config.clerk),
	supervisor,
	// File access: w1-lockdown replaces NO_FILE_ACCESS_SECTION with its provider (C5).
	provision: (tenantId) => {
		provisionTenant({ volumeDir: config.volumeDir, tenantId, fileAccess: NO_FILE_ACCESS_SECTION });
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
		void supervisor.stopAll().finally(() => process.exit(0));
	});
}
