/**
 * Shared set-up for the dashboard tests (W2-9): the real gateway and
 * dashboard handler on 127.0.0.1, PGlite with the real migrations, one
 * Owner, students, and a stand-in for each tenant's LearnHarness server
 * that records every request it gets. Only Clerk and the Next.js pages are
 * stand-ins, as in the other front door tests.
 */
import * as fs from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { createDashboard, type Dashboard } from "../frontdoor/admin/wiring.ts";
import { createPauseStandIn } from "../frontdoor/admin/pause.ts";
import type { TenantFetch } from "../frontdoor/admin/tenant-api.ts";
import type { TopicClassifier } from "../frontdoor/admin/flags.ts";
import * as dbm from "../frontdoor/db/index.ts";
import { createTestDb, type TestDb } from "../frontdoor/db/testing.ts";
import { createGateway } from "../frontdoor/gateway/handler.ts";
import { SESSION_COOKIE, signSession } from "../frontdoor/gateway/session.ts";
import type { AccountStore } from "../frontdoor/tenants/accounts.ts";

export const SECRET = new TextEncoder().encode("admin-test-session-secret-0123456789abcdef");
export const AGE = new Date("2026-11-01T12:00:00Z");

export interface FakeChat {
	id: string;
	title: string;
	topics: string[];
	markdown: string;
	createdAt?: string;
}

export interface Fixture {
	t: TestDb;
	db: dbm.Db;
	base: string;
	clock: { now: number };
	libraryDir: string;
	volume: string;
	dashboard: Dashboard;
	pause: ReturnType<typeof createPauseStandIn>;
	/** Every request each tenant server got: [tenantId, path]. */
	tenantHits: Array<[string, string]>;
	/** Chats per tenant on the stand-in tenant servers. */
	chats: Map<string, FakeChat[]>;
	/** Paths the stand-in Next.js app served. */
	pageHits: string[];
	owner: { accountId: string; clerkUserId: string };
	student(name?: string): Promise<{ tenantId: string; clerkUserId: string; accountId: string }>;
	cookie(clerkUserId: string, opts?: { checkedAt?: number; tenantId?: string }): Promise<string>;
	/** Same-origin headers for a state change from the dashboard's own page. */
	origin(): Record<string, string>;
	close(): Promise<void>;
}

function fakeTenantFetch(chats: Map<string, FakeChat[]>, hits: Array<[string, string]>): TenantFetch {
	return async (tenantId, p) => {
		hits.push([tenantId, p]);
		const list = chats.get(tenantId) ?? [];
		const at = "2026-11-08T10:00:00.000Z";
		if (p === "/api/chats") {
			return Response.json({
				chats: list.map((c) => ({ id: c.id, title: c.title, createdAt: c.createdAt ?? at, updatedAt: c.createdAt ?? at, kind: "teach", messageCount: 2, phase: "teach" })),
			});
		}
		const m = /^\/api\/chats\/([^/]+)(\/markdown)?$/.exec(p);
		const chat = m ? list.find((c) => c.id === decodeURIComponent(m[1] ?? "")) : undefined;
		if (!chat) return new Response("not found", { status: 404 });
		if (m?.[2]) return new Response(chat.markdown, { headers: { "Content-Type": "text/markdown" } });
		return Response.json({
			id: chat.id,
			title: chat.title,
			createdAt: chat.createdAt ?? at,
			updatedAt: chat.createdAt ?? at,
			kind: "teach",
			tree: { nodes: chat.topics.map((title, i) => ({ id: `n${i}`, title })), edges: [], version: 1 },
			messages: [{ role: "user", content: chat.markdown }],
		});
	};
}

export async function startFixture(options: { classifier?: TopicClassifier; labelTopics?: boolean } = {}): Promise<Fixture> {
	const t = await createTestDb();
	const db = t.db;
	const clock = { now: Date.parse("2026-11-08T18:00:00Z") };
	const volume = fs.mkdtempSync(path.join(os.tmpdir(), "fd-admin-"));
	const libraryDir = path.join(volume, "library");
	fs.mkdirSync(libraryDir, { recursive: true });
	const tenantHits: Array<[string, string]> = [];
	const chats = new Map<string, FakeChat[]>();
	const pageHits: string[] = [];
	const pause = createPauseStandIn();

	const ownerAccount = await dbm.createAccount(db, { clerkUserId: "user_owner", age18ConfirmedAt: AGE });
	await dbm.grantRole(db, { accountId: ownerAccount.id, role: "owner" });

	const frontDoorApp = (req: IncomingMessage, res: ServerResponse) => {
		pageHits.push(req.url ?? "");
		res.setHeader("Content-Type", "text/html");
		res.end("<p>admin page</p>");
	};
	const clerk = { isSessionActive: async () => true };
	const dashboard = createDashboard({
		db,
		sessionSecret: SECRET,
		clerk,
		secureCookies: false,
		trustForwardedHeaders: false,
		frontDoorApp,
		supervisor: { ensureRunning: async () => 1 },
		libraryDir,
		tenantFetch: fakeTenantFetch(chats, tenantHits),
		pause,
		classifier: options.classifier,
		labelTopics: options.labelTopics ?? false,
		now: () => clock.now,
	});
	const accounts: AccountStore = {
		async get(userId) {
			const a = await dbm.getAccountByClerkUserId(db, userId);
			if (!a) return null;
			const tn = await dbm.getTenantByAccountId(db, a.id);
			return { userId, tenantId: tn?.id ?? null, ageConfirmedAt: a.age18ConfirmedAt, createdAt: a.createdAt };
		},
		confirmAge: async () => {
			throw new Error("not used");
		},
		assignTenant: async () => {
			throw new Error("not used");
		},
	};
	const server: Server = createServer(
		createGateway({
			accounts,
			clerk: { authenticate: async () => ({ status: "signed-out" }), ...clerk },
			supervisor: { ensureRunning: async () => 1 },
			provision: async () => {},
			sessionSecret: SECRET,
			secureCookies: false,
			trustForwardedHeaders: false,
			frontDoorApp,
			now: () => clock.now,
			admin: dashboard.admin,
			studentRoutes: dashboard.studentRoutes,
		}),
	);
	await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
	const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

	let n = 0;
	return {
		t,
		db,
		base,
		clock,
		libraryDir,
		volume,
		dashboard,
		pause,
		tenantHits,
		chats,
		pageHits,
		owner: { accountId: ownerAccount.id, clerkUserId: "user_owner" },
		async student(name = `student_${++n}`) {
			const { account, tenant } = await dbm.createStudentAccount(db, { clerkUserId: `user_${name}`, age18ConfirmedAt: AGE });
			return { tenantId: tenant.id, clerkUserId: account.clerkUserId, accountId: account.id };
		},
		async cookie(clerkUserId, opts = {}) {
			const token = await signSession(
				{ userId: clerkUserId, sessionId: `sess_${clerkUserId}`, tenantId: opts.tenantId ?? "00000000-0000-4000-8000-000000000000", checkedAt: opts.checkedAt ?? clock.now },
				SECRET,
				clock.now,
			);
			return `${SESSION_COOKIE}=${token}`;
		},
		origin: () => ({ Origin: base }),
		async close() {
			await dashboard.close();
			await new Promise((r) => server.close(r));
			await t.close();
			fs.rmSync(volume, { recursive: true, force: true });
		},
	};
}
