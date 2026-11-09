/**
 * Email reports wired into the front door (W2-10): the start check, the
 * report pages behind the real gateway, the report loop, the Owner alert,
 * and the SES keys staying out of tenant servers.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";
import { createTestDb, type TestDb } from "../frontdoor/db/testing.ts";
import { assertEmailEnv } from "../frontdoor/email/config.ts";
import { MemoryEmailSender } from "../frontdoor/email/sender.ts";
import { runStartupChecks } from "../frontdoor/gateway/startup-checks.ts";
import { MemoryStudentDirectory } from "../frontdoor/reports/students.ts";
import { tenantServerEnv } from "../frontdoor/tenants/supervisor.ts";
import { STARTUP_CHECKS } from "../frontdoor/wiring/env.ts";
import type { FrontDoor } from "../frontdoor/wiring/front-door.ts";

const work = fs.mkdtempSync(path.join(os.tmpdir(), "fd-email-wiring-"));
const SES_SECRET = "ses-secret-value-must-never-reach-a-tenant-000";

const ENV: Record<string, string> = {
	NODE_ENV: "test",
	PATH: process.env.PATH ?? "",
	FRONTDOOR_SESSION_SECRET: "email-wiring-session-secret-0123456789abcd",
	CLERK_SECRET_KEY: "sk_test_email_wiring",
	NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: "pk_test_email_wiring",
	FRONTDOOR_VOLUME: path.join(work, "volume"),
	FRONTDOOR_TENANT_SERVER: path.join(work, "no-tenant-server.js"),
	FRONTDOOR_LISTEN_HOST: "127.0.0.1",
	PORT: "0",
	SES_REGION: "us-west-2",
	SES_ACCESS_KEY_ID: "AKIAEXAMPLEWIRING000",
	SES_SECRET_ACCESS_KEY: SES_SECRET,
	OWNER_ALERT_EMAIL: "owner@example.com",
};

let t: TestDb;
let frontDoor: FrontDoor;
const sender = new MemoryEmailSender();
const logs: string[] = [];

before(async () => {
	t = await createTestDb();
	const { startFrontDoor } = await import("../frontdoor/wiring/front-door.ts");
	frontDoor = await startFrontDoor({
		env: ENV,
		frontDoorApp: (_req, res) => res.end("front door page"),
		clerk: { authenticate: async () => ({ status: "signed-out" }), isSessionActive: async () => true },
		db: t.db,
		email: { sender, students: new MemoryStudentDirectory() },
		log: (line) => logs.push(line),
	});
});

after(async () => {
	await frontDoor?.close();
	await t?.close();
	fs.rmSync(work, { recursive: true, force: true });
});

describe("email in the start checks", () => {
	it("is one of the start checks, and a partial SES set in production stops the start", () => {
		assert.ok(STARTUP_CHECKS.includes(assertEmailEnv));
		assert.throws(() => runStartupChecks({ NODE_ENV: "production", SES_REGION: "us-west-2" }, [assertEmailEnv]), /SES_ACCESS_KEY_ID, SES_SECRET_ACCESS_KEY are not set/);
	});
});

describe("email reports in the running front door", () => {
	it("uses the local fake outside production and runs the report loop", () => {
		assert.equal(frontDoor.email.mode, "memory");
		assert.equal(frontDoor.email.sender, sender);
		assert.ok(frontDoor.email.runner);
		assert.ok(logs.includes("email: local fake, nothing is sent"));
	});

	it("serves the report pages through the gateway", async () => {
		const settings = await fetch(`${frontDoor.url}/account/reports`, { redirect: "manual" });
		assert.equal(settings.status, 302);
		assert.equal(settings.headers.get("location"), "/account/sign-in?next=%2Faccount%2Freports");
		const unsubscribe = await fetch(`${frontDoor.url}/account/unsubscribe?t=${"0".repeat(64)}&k=session`);
		assert.equal(unsubscribe.status, 404);
		assert.match(await unsubscribe.text(), /This link does not work/);
	});

	it("keeps /api closed without a login", async () => {
		const res = await fetch(`${frontDoor.url}/api/chats`);
		assert.equal(res.status, 401);
	});

	it("gives w2-pause an Owner alert sender that mails OWNER_ALERT_EMAIL", async () => {
		const result = await frontDoor.email.sendOwnerAlert({ kind: "cost-alert", tenantId: "00000000-0000-4000-8000-000000000001", costUsd: 60.5, thresholdUsd: 60 });
		assert.equal(result.sent, true);
		const m = sender.sent.at(-1);
		assert.equal(m?.kind, "owner-alert");
		assert.equal(m?.to, "owner@example.com");
	});

	it("never logs an address or the SES secret", () => {
		for (const line of logs) {
			assert.ok(!line.includes("@"), line);
			assert.ok(!line.includes(SES_SECRET), line);
		}
	});
});

describe("SES keys stay in the front door", () => {
	it("never passes an SES variable or the Owner address to a tenant server", () => {
		const env = tenantServerEnv({ serverScript: "server.js", volumeDir: path.join(work, "volume"), baseEnv: ENV }, "00000000-0000-4000-8000-000000000001", 4000);
		for (const name of ["SES_REGION", "SES_ACCESS_KEY_ID", "SES_SECRET_ACCESS_KEY", "OWNER_ALERT_EMAIL"]) assert.equal(env[name], undefined, name);
		assert.ok(!Object.values(env).includes(SES_SECRET));
	});
});
