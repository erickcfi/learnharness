/**
 * The student's session-text switch (P3-04, C7 req 3, D19): "Opt-in is a
 * student setting, off by default. Store each consent with its date."
 *
 *   /account/sharing           the page (app/account/sharing/page.tsx)
 *   POST /_frontdoor/sharing   the form: share=on turns it on; no share turns it off
 *
 * The gateway calls handle() only after the login check, with the login's
 * tenant, so a student can change only their own switch. Turning it off
 * takes effect at the dashboard's next view (admin/session-text.ts reads
 * consent on every view).
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { setSessionTextOptIn } from "../admin/session-text.ts";
import { isSameOrigin } from "../admin/origin.ts";
import type { Db } from "../db/index.ts";

import { SHARING_PAGE, SHARING_PATH } from "./paths.ts";

export { SHARING_PAGE, SHARING_PATH };

const MAX_FORM_BYTES = 1024;

export interface SharingEndpoint {
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

export function createSharingEndpoint(options: { db: Db | null; trustForwardedHeaders: boolean; now?: () => number }): SharingEndpoint {
	const send = (res: ServerResponse, status: number, headers: Record<string, string> = {}) => {
		res.writeHead(status, { "Cache-Control": "no-store", ...headers });
		res.end();
	};
	return {
		handles: (pathname) => pathname === SHARING_PATH,
		async handle(req, res, tenantId) {
			if (req.method !== "POST") return send(res, 405, { Allow: "POST" });
			if (!isSameOrigin(req, options.trustForwardedHeaders)) return send(res, 403);
			if (!options.db) return send(res, 503);
			const form = await readForm(req);
			if (!form) return send(res, 413, { Connection: "close" });
			const on = form.get("share") === "on";
			await setSessionTextOptIn(options.db, tenantId, on, new Date(options.now ? options.now() : Date.now()));
			send(res, 303, { Location: `${SHARING_PAGE}?saved=${on ? "on" : "off"}` });
		},
	};
}
