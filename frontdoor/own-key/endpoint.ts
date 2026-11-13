/**
 * The student's own AI key, behind the tutor's login (2026-11-13):
 *
 *   /account/ai-key          the page (app/account/ai-key/page.tsx)
 *   GET  /_frontdoor/ai-key  JSON: { enabled, saved, last4, savedAt }. Never more of the key.
 *   POST /_frontdoor/ai-key  the page's forms: action=save with key=..., or action=remove.
 *                            Answers 303 back to the page with ?saved=1, ?removed=1 or ?error=<problem>.
 *                            The key is never put in an address.
 *
 * The gateway calls handle() only after the login check, with the login's
 * tenant (gateway/handler.ts, studentRoutes), so a student can change only
 * their own key. A POST must come from the site's own page (same origin).
 * The request body is never logged.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { isSameOrigin } from "../admin/origin.ts";
import { errorLabel } from "../log-hygiene/filter.ts";
import { OWN_KEY_PAGE, OWN_KEY_PATH } from "./paths.ts";
import type { OwnKeys } from "./service.ts";

const MAX_FORM_BYTES = 2048;

export interface OwnKeyEndpoint {
	handles(pathname: string): boolean;
	handle(req: IncomingMessage, res: ServerResponse, tenantId: string, pathname: string): Promise<void>;
}

function readForm(req: IncomingMessage): Promise<URLSearchParams | null> {
	return new Promise((resolve, reject) => {
		let size = 0;
		const chunks: Buffer[] = [];
		req.on("data", (chunk: Buffer) => {
			size += chunk.length;
			if (size > MAX_FORM_BYTES) {
				req.removeAllListeners("data");
				req.pause();
				resolve(null);
				return;
			}
			chunks.push(chunk);
		});
		req.on("end", () => resolve(new URLSearchParams(Buffer.concat(chunks).toString("utf8"))));
		req.on("error", reject);
	});
}

export function createOwnKeyEndpoint(options: { ownKeys: OwnKeys; trustForwardedHeaders: boolean; log?: (line: string) => void }): OwnKeyEndpoint {
	const { ownKeys } = options;
	const log = options.log ?? ((line: string) => console.error(line));
	const send = (res: ServerResponse, status: number, headers: Record<string, string> = {}, body = "") => {
		res.writeHead(status, { "Cache-Control": "no-store", ...headers });
		res.end(body);
	};
	const back = (res: ServerResponse, query: string) => send(res, 303, { Location: `${OWN_KEY_PAGE}?${query}` });

	return {
		handles: (pathname) => pathname === OWN_KEY_PATH,
		async handle(req, res, tenantId) {
			if (req.method === "GET" || req.method === "HEAD") {
				let status;
				try {
					status = await ownKeys.status(tenantId);
				} catch (error) {
					log(`own key: status for tenant ${tenantId} could not be read (${errorLabel(error)})`);
					return send(res, 503, { "Content-Type": "application/json" }, JSON.stringify({ error: "Try again in a minute." }));
				}
				const body = { enabled: status.enabled, saved: status.saved !== null, last4: status.saved?.last4 ?? null, savedAt: status.saved?.savedAt.toISOString() ?? null };
				return send(res, 200, { "Content-Type": "application/json" }, req.method === "HEAD" ? "" : JSON.stringify(body));
			}
			if (req.method !== "POST") return send(res, 405, { Allow: "GET, POST" });
			if (!isSameOrigin(req, options.trustForwardedHeaders)) return send(res, 403);
			const form = await readForm(req);
			if (!form) return send(res, 413, { Connection: "close" });
			const action = form.get("action");
			if (action === "remove") {
				try {
					await ownKeys.remove(tenantId);
				} catch (error) {
					log(`own key: tenant ${tenantId}'s key could not be removed (${errorLabel(error)})`);
					return back(res, "error=failed");
				}
				return back(res, "removed=1");
			}
			if (action !== "save") return send(res, 400);
			let result;
			try {
				result = await ownKeys.save(tenantId, form.get("key") ?? "");
			} catch (error) {
				log(`own key: tenant ${tenantId}'s key could not be saved (${errorLabel(error)})`);
				return back(res, "error=failed");
			}
			return back(res, result.ok ? "saved=1" : `error=${result.problem}`);
		},
	};
}
