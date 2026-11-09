import { NextResponse, type NextRequest } from "next/server";
import { desktopAPIAuthorized } from "./src/server/desktop-access.ts";

/** Applies to every API method, including SSE and spending/settings routes.
 * No public callback or worker bypass: internal jobs call server functions,
 * and any legitimate self-HTTP request must carry the private capability.
 *
 * North Aero fork (W2-6, docs/upstream-changes.md): with LH_HOSTED=1, set by
 * the front door for each student's server, the check covers EVERY path,
 * pages and static files included, and a missing or short secret refuses
 * everything. Unset, only /api is checked, exactly as upstream. */
export function proxy(request: NextRequest) {
	const hosted = process.env.LH_HOSTED === "1";
	const path = request.nextUrl.pathname;
	if (!hosted && path !== "/api" && !path.startsWith("/api/")) return NextResponse.next();
	if (!desktopAPIAuthorized(request.headers, hosted ? { ...process.env, LH_DESKTOP_SERVER: "1" } : process.env)) {
		return NextResponse.json(
			{ error: "Desktop API access requires the trusted LearnHarness window." },
			{ status: 403, headers: { "Cache-Control": "no-store" } },
		);
	}
	return NextResponse.next();
}

// Fork (W2-6): no matcher, so Proxy runs on every request (Next 16 proxy.md).
// The function above keeps upstream's /api-only check when LH_HOSTED is unset.
