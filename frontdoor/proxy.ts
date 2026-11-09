import { clerkMiddleware } from "@clerk/nextjs/server";

/**
 * Clerk on the front door's own pages (Clerk's Next.js quickstart). Requests
 * the custom server passes through to tenants never reach Next.js, so the
 * gateway checks those itself (gateway/handler.ts).
 *
 * Only the account pages: the public pages (landing, How it works, Help,
 * legal, robots.txt, sitemap.xml) and the brand files under /account/brand/
 * never touch Clerk (W2-11).
 */
export default clerkMiddleware();

export const config = {
	matcher: [
		// /account pages only. Skip Next.js internals, the brand files, and static files.
		"/account((?!/_next|/brand/|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
	],
};
