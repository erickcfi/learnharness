/**
 * The front door's study-time routes (P3-02, PD1). The gateway calls
 * handle() after it has checked the student's login, so every heartbeat
 * belongs to the tenant in the login cookie:
 *
 *   GET  /_frontdoor/activity.js  the heartbeat script (script.ts)
 *   POST /_frontdoor/activity     one heartbeat: {"path": "/chat/<id>"}
 *
 * The chat id comes from the page path the script reports. Anything that is
 * not an upstream chat page counts as study time outside any chat.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { StudyTimeRecorder } from "./recorder.ts";
import { ACTIVITY_PATH, ACTIVITY_SCRIPT, ACTIVITY_SCRIPT_PATH } from "./script.ts";

const MAX_BODY_BYTES = 2048;
/** Upstream's chat ids: chat_<base36>_<hex> (src/store/chats.ts allows [A-Za-z0-9_-]). */
const CHAT_ID = /^[A-Za-z0-9_-]{1,128}$/;

/** The upstream chat id in a tutor page path such as /chat/chat_abc_123, or null. */
export function chatIdFromPath(pathname: unknown): string | null {
	if (typeof pathname !== "string") return null;
	const match = /^\/chat\/([^/?#]+)(?:\/|$)/.exec(pathname);
	if (!match?.[1]) return null;
	let id: string;
	try {
		id = decodeURIComponent(match[1]);
	} catch {
		return null;
	}
	if (id === "new" || !CHAT_ID.test(id)) return null;
	return id;
}

export interface StudyTimeEndpoint {
	handles(pathname: string): boolean;
	/** `pathname` is the gateway's normalized path. */
	handle(req: IncomingMessage, res: ServerResponse, tenantId: string, pathname: string): Promise<void>;
}

function readBody(req: IncomingMessage): Promise<string | null> {
	return new Promise((resolve, reject) => {
		let size = 0;
		const chunks: Buffer[] = [];
		req.on("data", (chunk: Buffer) => {
			size += chunk.length;
			if (size > MAX_BODY_BYTES) {
				// Stop reading; the 413 answer closes the connection.
				req.removeAllListeners("data");
				req.pause();
				resolve(null);
				return;
			}
			chunks.push(chunk);
		});
		req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
		req.on("error", reject);
	});
}

export function createStudyTimeEndpoint(options: { recorder: StudyTimeRecorder | null }): StudyTimeEndpoint {
	const send = (res: ServerResponse, status: number, headers: Record<string, string> = {}, body = "") => {
		res.writeHead(status, { "Cache-Control": "no-store", ...headers });
		res.end(body);
	};
	return {
		handles: (pathname) => pathname === ACTIVITY_PATH || pathname === ACTIVITY_SCRIPT_PATH,
		async handle(req, res, tenantId, pathname) {
			if (pathname === ACTIVITY_SCRIPT_PATH) {
				if (req.method !== "GET" && req.method !== "HEAD") return send(res, 405, { Allow: "GET, HEAD" });
				return send(res, 200, { "Content-Type": "text/javascript; charset=utf-8", "Cache-Control": "private, max-age=300" }, req.method === "HEAD" ? "" : ACTIVITY_SCRIPT);
			}
			if (req.method !== "POST") return send(res, 405, { Allow: "POST" });
			// The login cookie is SameSite=Lax, so another site's page cannot send it; this is a second check.
			if (req.headers["sec-fetch-site"] === "cross-site") return send(res, 403);
			const raw = await readBody(req);
			if (raw === null) return send(res, 413, { Connection: "close" });
			let path: unknown = null;
			try {
				path = (JSON.parse(raw || "{}") as { path?: unknown }).path ?? null;
			} catch {
				return send(res, 400);
			}
			await options.recorder?.beat(tenantId, chatIdFromPath(path));
			send(res, 204);
		},
	};
}
