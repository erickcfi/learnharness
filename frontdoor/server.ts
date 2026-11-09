/**
 * The front door's custom Node server (PRD X5, approved 2026-11-08).
 *
 * Run: `npm run start -w frontdoor` after `npm run build` (upstream),
 * `node scripts/build-server.mjs`, and `npm run build -w frontdoor`.
 * tsx runs this file (master decision, 2026-11-08): the meter prices calls
 * with upstream's src/server/pricing.ts, whose imports use TypeScript that
 * plain Node cannot strip.
 *
 * Order matters:
 *  1. The log filter, before anything can print (lockdown, cross-cutting req 3).
 *  2. The start checks (wiring/env.ts), before Next.js or upstream code
 *     loads, so a bad Railway variable fails the deploy at once.
 *  3. Next.js, which serves only the front door's own pages under /account.
 *  4. Everything else (wiring/front-door.ts): database, lockdown, meter,
 *     tenant servers, and the gateway that passes every other request
 *     through to the student's own LearnHarness server.
 */
import "./log-hygiene/preload.ts";
import { preflight } from "./wiring/env.ts";

const log = (message: string) => console.log(`[frontdoor] ${message}`);

let config;
try {
	({ config } = preflight(process.env));
} catch (error) {
	console.error((error as Error).message);
	process.exit(1);
}

const { default: next } = await import("next");
const { startFrontDoor } = await import("./wiring/front-door.ts");

// No `hostname` option: Next.js then names itself "localhost" everywhere. With
// one, Clerk's middleware rewrite looked cross-origin to Next.js, which tried
// to proxy the page to itself and failed (smoke test, 2026-11-08).
const app = next({ dev: config.dev, dir: import.meta.dirname, port: config.port });
await app.prepare();
const handleNext = app.getRequestHandler();

const frontDoor = await startFrontDoor({ env: process.env, frontDoorApp: (req, res) => handleNext(req, res), log });

for (const signal of ["SIGTERM", "SIGINT"] as const) {
	process.once(signal, () => {
		log(`${signal}: stopping tenant servers and writing usage`);
		void frontDoor
			.close()
			.catch((error: unknown) => log(`shutdown problem: ${(error as Error).message}`))
			.finally(() => process.exit(0));
	});
}
