import { clerkMiddleware } from "@clerk/nextjs/server";

/**
 * Clerk on the front door's own pages (Clerk's Next.js quickstart). Requests
 * the custom server passes through to tenants never reach Next.js, so the
 * gateway checks those itself (gateway/handler.ts).
 */
export default clerkMiddleware();

export const config = {
	matcher: [
		// Skip Next.js internals and static files, unless found in search params.
		"/((?!_next|account/_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
	],
};
