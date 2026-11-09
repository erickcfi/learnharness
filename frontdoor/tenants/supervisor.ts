/**
 * One LearnHarness server process per tenant (PRD X1 jobs 2 and 3, C1 req 3, PD4).
 *
 * ensureRunning(tenantId) returns the port of the tenant's server, starting
 * it first if needed. A server starts on the tenant's first login and keeps
 * running: there is no idle stop at launch (PD4). If it stops, the next
 * request starts it again.
 *
 * Each server:
 * - runs upstream's standalone build (`node .next/standalone/server.js`);
 * - listens on 127.0.0.1 only, on a free port, so only the front door can
 *   reach it;
 * - gets an environment built from a short allowlist. The front door's own
 *   secrets (Clerk, Supabase, Stripe, the Anthropic key, the session secret)
 *   and the debug-capture switches never reach it;
 * - sees only its own folder: LH_DATA_DIR and HOME are the tenant folder,
 *   TMPDIR is <tenant folder>/.tmp, and LH_AUTH_FILE is the tenant's key
 *   file outside that folder;
 * - runs in hosted mode (LH_HOSTED=1, W2-6) with its own random secret
 *   (LH_DESKTOP_API_SECRET, 64 characters, new at every start). It refuses
 *   any request, on any path, without that secret in the
 *   x-learnharness-desktop header. Only this process knows the secret:
 *   endpoint() gives it to the gateway and to any front door code that
 *   calls the tenant (records, dashboard, email reports).
 */
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import { createServer } from "node:net";
import * as path from "node:path";
import { assertTenantId, tenantAuthFile, tenantDir } from "./paths.ts";

/** The header a tenant server checks (upstream src/server/desktop-access.ts). */
export const TENANT_SECRET_HEADER = "x-learnharness-desktop";

/** Where one tenant server is, and the headers every request to it needs. */
export interface TenantEndpoint {
	port: number;
	/** For example http://127.0.0.1:41234 */
	url: string;
	headers: Record<string, string>;
}

/** 48 random bytes, base64url: 64 characters (upstream needs 64 or more). */
export function newTenantSecret(): string {
	return randomBytes(48).toString("base64url");
}

/** Each tenant's own temp folder, inside its tenant folder (C1 req 4). */
export const tenantTempDir = (volumeDir: string, tenantId: string) => path.join(tenantDir(volumeDir, tenantId), ".tmp");

export interface TenantSupervisorOptions {
	/** Upstream's standalone server: <repo>/.next/standalone/server.js. */
	serverScript: string;
	volumeDir: string;
	/** Where PATH and the locale come from. Defaults to process.env. Only
	 *  PASSED_ENV_KEYS are copied from it. */
	baseEnv?: Record<string, string | undefined>;
	/** Variables added for each tenant. wiring/front-door.ts gives the
	 *  library path (lockdown) and the metering pass key and address, in
	 *  place of the real Anthropic and Tavily keys. It cannot replace the
	 *  tenant's own folder, port, or host settings. */
	extraEnv?: (tenantId: string) => Record<string, string>;
	/** Defaults to the Node running the front door. */
	nodeBinary?: string;
	/** Node options placed before the server script. wiring/front-door.ts
	 *  gives ["--import", <lockdown's log filter>]. */
	nodeArgs?: string[];
	/** How long a server may take to answer its first request. Default 30 s. */
	startTimeoutMs?: number;
	/** The server's own log output. Default: dropped. wiring/front-door.ts
	 *  passes stderr only, filtered and capped (wiring/tenant-logs.ts). */
	onOutput?: (tenantId: string, stream: "stdout" | "stderr", chunk: Buffer) => void;
	onExit?: (tenantId: string, code: number | null, signal: NodeJS.Signals | null) => void;
	/** Runs before each start, for example to write the Owner's settings
	 *  template again (P2-04: the template wins if settings.json drifted).
	 *  A throw stops the start. */
	prepare?: (tenantId: string) => void | Promise<void>;
}

/** The only variables copied from the front door's environment. */
export const PASSED_ENV_KEYS = ["PATH", "LANG", "LC_ALL", "TZ"] as const;

export function tenantServerEnv(options: TenantSupervisorOptions, tenantId: string, port: number, secret?: string): Record<string, string> {
	const base = options.baseEnv ?? process.env;
	const env: Record<string, string> = {};
	for (const key of PASSED_ENV_KEYS) {
		const value = base[key];
		if (value !== undefined) env[key] = value;
	}
	Object.assign(env, options.extraEnv?.(tenantId) ?? {});
	const dir = tenantDir(options.volumeDir, tenantId);
	Object.assign(env, {
		NODE_ENV: "production",
		NEXT_TELEMETRY_DISABLED: "1",
		PORT: String(port),
		HOSTNAME: "127.0.0.1",
		LH_DATA_DIR: dir,
		LH_AUTH_FILE: tenantAuthFile(options.volumeDir, tenantId),
		HOME: dir,
		TMPDIR: tenantTempDir(options.volumeDir, tenantId),
		// W2-6: hosted mode. The secret on every path, the web_fetch address
		// guard, and the hidden student controls (upstream reads it).
		LH_HOSTED: "1",
	});
	// The desktop variable is never set: it would turn on upstream's IPC paths.
	delete env.LH_DESKTOP_SERVER;
	if (secret === undefined) delete env.LH_DESKTOP_API_SECRET;
	else env.LH_DESKTOP_API_SECRET = secret;
	return env;
}

interface Running {
	child: ChildProcess;
	port: number;
	secret: string;
}

function freePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const probe = createServer();
		probe.unref();
		probe.on("error", reject);
		probe.listen(0, "127.0.0.1", () => {
			const address = probe.address();
			const port = typeof address === "object" && address ? address.port : 0;
			probe.close(() => (port ? resolve(port) : reject(new Error("No free port"))));
		});
	});
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class TenantSupervisor {
	readonly #options: TenantSupervisorOptions;
	readonly #running = new Map<string, Running>();
	readonly #starting = new Map<string, Promise<number>>();

	constructor(options: TenantSupervisorOptions) {
		this.#options = options;
	}

	isRunning(tenantId: string): boolean {
		return this.#running.has(tenantId);
	}

	async ensureRunning(tenantId: string): Promise<number> {
		assertTenantId(tenantId);
		const running = this.#running.get(tenantId);
		if (running) return running.port;
		const pending = this.#starting.get(tenantId);
		if (pending) return pending;
		const start = this.#start(tenantId).finally(() => this.#starting.delete(tenantId));
		this.#starting.set(tenantId, start);
		return start;
	}

	/**
	 * The tenant's server (started if needed), with the headers every request
	 * to it needs. Use this, not ensureRunning(), for any request to a tenant.
	 */
	async endpoint(tenantId: string): Promise<TenantEndpoint> {
		for (let attempt = 0; attempt < 3; attempt++) {
			const port = await this.ensureRunning(tenantId);
			const running = this.#running.get(tenantId);
			// The server can stop between the two lines; then start it again.
			if (running?.port === port) return { port, url: `http://127.0.0.1:${port}`, headers: { [TENANT_SECRET_HEADER]: running.secret } };
		}
		throw new Error(`Tenant server ${tenantId} keeps stopping.`);
	}

	/** fetch() to one tenant's server, with its secret. `pathname` starts with "/". */
	async tenantFetch(tenantId: string, pathname: string, init: RequestInit = {}): Promise<Response> {
		if (!pathname.startsWith("/") || pathname.startsWith("//")) throw new Error("tenantFetch needs a path that starts with one /");
		const { url, headers } = await this.endpoint(tenantId);
		const merged = new Headers(init.headers);
		for (const [name, value] of Object.entries(headers)) merged.set(name, value);
		return fetch(`${url}${pathname}`, { ...init, headers: merged });
	}

	/** Stops every tenant server (front door shutdown, tests). */
	async stopAll(): Promise<void> {
		const children = [...this.#running.values()].map((r) => r.child);
		this.#running.clear();
		await Promise.all(
			children.map(
				(child) =>
					new Promise<void>((resolve) => {
						if (child.exitCode !== null || child.signalCode !== null) return resolve();
						const force = setTimeout(() => child.kill("SIGKILL"), 5000);
						child.once("exit", () => {
							clearTimeout(force);
							resolve();
						});
						child.kill("SIGTERM");
					}),
			),
		);
	}

	async #start(tenantId: string): Promise<number> {
		const options = this.#options;
		await options.prepare?.(tenantId);
		fs.mkdirSync(tenantTempDir(options.volumeDir, tenantId), { recursive: true, mode: 0o700 });
		const port = await freePort();
		const secret = newTenantSecret();
		const child = spawn(options.nodeBinary ?? process.execPath, [...(options.nodeArgs ?? []), options.serverScript], {
			cwd: path.dirname(options.serverScript),
			// The cast: Next.js's types mark NODE_ENV required; tenantServerEnv always sets it.
			env: tenantServerEnv(options, tenantId, port, secret) as NodeJS.ProcessEnv,
			stdio: ["ignore", "pipe", "pipe"],
		});
		child.stdout?.on("data", (chunk: Buffer) => options.onOutput?.(tenantId, "stdout", chunk));
		child.stderr?.on("data", (chunk: Buffer) => options.onOutput?.(tenantId, "stderr", chunk));

		let exited = false;
		child.once("error", () => {
			exited = true;
		});
		child.once("exit", (code, signal) => {
			exited = true;
			if (this.#running.get(tenantId)?.child === child) this.#running.delete(tenantId);
			options.onExit?.(tenantId, code, signal);
		});

		const deadline = Date.now() + (options.startTimeoutMs ?? 30_000);
		while (Date.now() < deadline) {
			if (exited) throw new Error(`Tenant server ${tenantId} exited before it was ready.`);
			try {
				const res = await fetch(`http://127.0.0.1:${port}/`, { redirect: "manual", headers: { [TENANT_SECRET_HEADER]: secret }, signal: AbortSignal.timeout(2000) });
				await res.body?.cancel();
				if (exited) break;
				this.#running.set(tenantId, { child, port, secret });
				return port;
			} catch {
				await sleep(100);
			}
		}
		child.kill("SIGKILL");
		throw new Error(`Tenant server ${tenantId} did not start within ${options.startTimeoutMs ?? 30_000} ms.`);
	}
}
