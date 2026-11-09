/** Same-origin checks for the front door's own forms (admin and student). */
import type { IncomingMessage } from "node:http";

const firstValue = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value)?.split(",")[0]?.trim();

export function selfOrigin(req: IncomingMessage, trustForwardedHeaders: boolean): string {
	const proto =
		(trustForwardedHeaders ? firstValue(req.headers["x-forwarded-proto"]) : undefined) ??
		("encrypted" in req.socket && req.socket.encrypted ? "https" : "http");
	const host = (trustForwardedHeaders ? firstValue(req.headers["x-forwarded-host"]) : undefined) ?? req.headers.host ?? "localhost";
	return `${proto}://${host}`;
}

/** A state change must come from the site's own pages: a matching Origin, or Sec-Fetch-Site: same-origin. */
export function isSameOrigin(req: IncomingMessage, trustForwardedHeaders: boolean): boolean {
	const origin = req.headers.origin;
	if (origin) return origin === selfOrigin(req, trustForwardedHeaders);
	return req.headers["sec-fetch-site"] === "same-origin";
}
