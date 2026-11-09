// X5 spike, method "px": Next.js proxy.js rewrites to the tenant's origin.
// Path: /px/<port>/<path>.
import { NextResponse } from "next/server";

export function proxy(request) {
	const m = /^\/px\/(\d+)(\/.*)$/.exec(request.nextUrl.pathname);
	if (!m) return NextResponse.next();
	return NextResponse.rewrite(new URL(`${m[2]}${request.nextUrl.search}`, `http://127.0.0.1:${m[1]}`));
}

export const config = { matcher: "/px/:path*" };
