/**
 * Tenant B's server for tests/frontdoor-metering-research.test.ts: one
 * teaching call through the metering proxy, in its own process, as every
 * tenant runs in production (X1 option A). The parent passes the proxy
 * address and B's pass key in the environment. Prints the call's
 * stopReason and reported usage as JSON.
 *
 * A helper, not a test file: `npm test` runs tests/*.test.ts.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { blockExternalFetch } from "./frontdoor-metering-fakes.ts";

blockExternalFetch();
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "lh-metering-tenant-b-"));
process.env.LH_DATA_DIR = scratch;
try {
	const { normalizeContext } = await import("@earendil-works/pi-ai");
	const { piEngineForSpec } = await import("../src/agent/models.ts");
	const engine = piEngineForSpec({ provider: "anthropic", id: "claude-opus-5-5" }, false);
	const context = normalizeContext({ messages: [{ role: "user", content: "tenant B turn", timestamp: Date.now() }] });
	const message = await engine.streamFn(engine.model, context, {}).result();
	process.stdout.write(JSON.stringify({ stopReason: message.stopReason, usage: message.usage }));
} finally {
	fs.rmSync(scratch, { recursive: true, force: true });
}
