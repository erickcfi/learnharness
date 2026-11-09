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
 *   and LH_AUTH_FILE is the tenant's key file outside that folder.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import * as path from "node:path";
import { assertTenantId, tenantAuthFile, tenantDir } from "./paths.ts";

export interface TenantSupervisorOptions {
	/** Upstream's standalone server: <repo>/.next/standalone/server.js. */
	serverScript: string;
	volumeDir: string;
	/** Where PATH and the locale come from. Defaults to process.env. Only
	 *  PASSED_ENV_KEYS are copied from it. */
	baseEnv?: Record<string, string | undefined>;
	/** PLUG POINT for later packages: w1-metering's per-tenant pass key
	 *  (in place of the real Anthropic and Tavily keys), w1-lockdown's
	 *  library path. Compose several in server.ts. It cannot replace the
	 *  tenant's own folder, port, or host settings. */
	extraEnv?: (tenantId: string) => Record<string, string>;
	/** Defaults to the Node running the front door. */
	nodeBinary?: string;
	/** PLUG POINT for w1-lockdown: Node options placed before the server
	 *  script, for example ["--import", "<log filter module>"]. */
	nodeArgs?: string[];
	/** How long a server may take to answer its first request. Default 30 s. */
	startTimeoutMs?: number;
	/** The server's own log output. Default: dropped. Log hygiene (P1-10)
	 *  decides what may reach the front door's logs. */
	onOutput?: (tenantId: string, stream: "stdout" | "stderr", chunk: Buffer) => void;
	onExit?: (tenantId: string, code: number | null, signal: NodeJS.Signals | null) => void;
}

/** The only variables copied from the front door's environment. */
export const PASSED_ENV_KEYS = ["PATH", "LANG", "LC_ALL", "TZ"] as const;

export function tenantServerEnv(options: TenantSupervisorOptions, tenantId: string, port: number): Record<string, string> {
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
	});
	return env;
}

interface Running {
	child: ChildProcess;
	port: number;
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
		const port = await freePort();
		const child = spawn(options.nodeBinary ?? process.execPath, [...(options.nodeArgs ?? []), options.serverScript], {
			cwd: path.dirname(options.serverScript),
			// The cast: Next.js's types mark NODE_ENV required; tenantServerEnv always sets it.
			env: tenantServerEnv(options, tenantId, port) as NodeJS.ProcessEnv,
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
				const res = await fetch(`http://127.0.0.1:${port}/`, { redirect: "manual", signal: AbortSignal.timeout(2000) });
				await res.body?.cancel();
				if (exited) break;
				this.#running.set(tenantId, { child, port });
				return port;
			} catch {
				await sleep(100);
			}
		}
		child.kill("SIGKILL");
		throw new Error(`Tenant server ${tenantId} did not start within ${options.startTimeoutMs ?? 30_000} ms.`);
	}
}
