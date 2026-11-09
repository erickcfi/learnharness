/**
 * Start a REAL upstream LearnHarness server for the reporting contract
 * tests (frontdoor-records-contract.test.ts, C7 req 7): `next dev` on
 * 127.0.0.1, a kernel-assigned free port, a throwaway LH_DATA_DIR and an
 * empty LH_AUTH_FILE (no keys, so no model call can happen). Requests go
 * through Next.js routing and proxy.ts exactly as the front door's will.
 *
 * Next.js 16 allows one `next dev` per project folder (a lockfile), so a
 * dev server already running in this checkout makes the boot fail; the
 * error says so. The child runs in its own process group and stop()
 * kills the whole group: a leaked server would hold its port.
 */
import { spawn, type ChildProcess } from "node:child_process";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const NEXT_BIN = path.join(ROOT, "node_modules", "next", "dist", "bin", "next");

export interface UpstreamServer {
	url: string;
	stop(): Promise<void>;
	logTail(): string;
}

function freePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const srv = net.createServer();
		srv.listen(0, "127.0.0.1", () => {
			const address = srv.address();
			const port = typeof address === "object" && address ? address.port : 0;
			srv.close(() => resolve(port));
		});
		srv.on("error", reject);
	});
}

/** The child's environment: ours, minus anything that would change upstream's behavior. */
function childEnv(dataDir: string, authFile: string, port: number): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = { ...process.env };
	for (const key of ["LH_DESKTOP_SERVER", "LH_DESKTOP_API_SECRET", "LH_PROVIDER_EVENTS", "LH_BACKGROUND_CAPTURE"]) delete env[key];
	if (env.NODE_OPTIONS?.includes("tsx")) delete env.NODE_OPTIONS;
	return {
		...env,
		NODE_ENV: "development",
		NEXT_TELEMETRY_DISABLED: "1",
		PORT: String(port),
		LH_DATA_DIR: dataDir,
		LH_AUTH_FILE: authFile,
	};
}

function killGroup(child: ChildProcess, signal: NodeJS.Signals): void {
	try {
		if (process.platform !== "win32" && child.pid !== undefined) process.kill(-child.pid, signal);
		else child.kill(signal);
	} catch {
		/* already gone */
	}
}

export async function startUpstreamDevServer(opts: { dataDir: string; authFile: string; bootTimeoutMs?: number }): Promise<UpstreamServer> {
	const port = await freePort();
	const url = `http://127.0.0.1:${port}`;
	const lines: string[] = [];
	const keep = (buf: Buffer) => {
		lines.push(...buf.toString().split("\n"));
		if (lines.length > 200) lines.splice(0, lines.length - 200);
	};
	const child = spawn(process.execPath, [NEXT_BIN, "dev", "-p", String(port), "-H", "127.0.0.1"], {
		cwd: ROOT,
		env: childEnv(opts.dataDir, opts.authFile, port),
		detached: process.platform !== "win32",
		stdio: ["ignore", "pipe", "pipe"],
	});
	child.stdout?.on("data", keep);
	child.stderr?.on("data", keep);
	let exited = false;
	child.on("exit", () => {
		exited = true;
	});
	const logTail = () => lines.filter((l) => l.trim()).slice(-40).join("\n");

	const stop = () =>
		new Promise<void>((resolve) => {
			if (exited) return resolve();
			const timer = setTimeout(() => {
				killGroup(child, "SIGKILL");
				resolve();
			}, 5000);
			child.once("exit", () => {
				clearTimeout(timer);
				resolve();
			});
			killGroup(child, "SIGTERM");
		});

	const deadline = Date.now() + (opts.bootTimeoutMs ?? 150_000);
	let last = "no answer yet";
	while (Date.now() < deadline) {
		if (exited) {
			const log = logTail();
			const lock = /already running|lockfile|lock file/i.test(log)
				? "\nAnother `next dev` seems to be running in this checkout. Stop it and run the tests again."
				: "";
			throw new Error(`upstream dev server exited before answering${lock}\n--- server log ---\n${log}`);
		}
		try {
			const res = await fetch(`${url}/api/chats`, { signal: AbortSignal.timeout(30_000) });
			await res.arrayBuffer();
			if (res.status === 200) return { url, stop, logTail };
			last = `GET /api/chats -> ${res.status}`;
		} catch (err) {
			last = (err as Error).message;
		}
		await new Promise((r) => setTimeout(r, 500));
	}
	await stop();
	throw new Error(`upstream dev server never answered 200 on ${url} (${last})\n--- server log ---\n${logTail()}`);
}
