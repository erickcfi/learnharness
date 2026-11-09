/**
 * The front door's public pages (W2-11): what a visitor reaches with no
 * login. The gateway (gateway/handler.ts) reads this list.
 *
 * - "/" is the landing page for visitors with no front door login. A
 *   signed-in student still goes straight to their tutor.
 * - The pages below are always the front door's, login or not. Upstream
 *   LearnHarness has no routes at these paths (only /, /chat/*, /settings
 *   and /api/*), so nothing of the tutor's is hidden.
 * - The icon and the Open Graph image live under /account/brand/, which the
 *   gateway already sends to the front door's app.
 *
 * Framework-free and runnable by plain Node (type stripping).
 */

export const LANDING_PATH = "/";
export const HOW_IT_WORKS_PATH = "/how-it-works";
export const HELP_PATH = "/help";
export const LEGAL_PATHS = {
	terms: "/legal/terms",
	privacy: "/legal/privacy",
	aiNotice: "/legal/ai-notice",
	/** The AGPL notices and full license text (frontdoor/legal-notices). */
	license: "/legal/license",
} as const;

/** Where "Start your free trial" leads: the 18+ box, then Clerk's form. */
export const SIGN_UP_PATH = "/account/sign-up";
export const SIGN_IN_PATH = "/account/sign-in";

/** The icon and the share image, served by the front door's app. */
export const BRAND_ICON_PATH = "/account/brand/icon.svg";
export const OG_IMAGE_PATH = "/account/brand/og";

/** Every public page, for the sitemap. */
export const PUBLIC_PAGES: readonly string[] = [LANDING_PATH, HOW_IT_WORKS_PATH, HELP_PATH, LEGAL_PATHS.terms, LEGAL_PATHS.privacy, LEGAL_PATHS.aiNotice, LEGAL_PATHS.license];

const ALWAYS_PUBLIC = new Set<string>([HOW_IT_WORKS_PATH, HELP_PATH, "/robots.txt", "/sitemap.xml"]);

/**
 * True for a path the front door's app serves to everyone, signed in or
 * not. Takes the gateway's normalized path ("..", "%2e%2e" already
 * resolved). One trailing slash is allowed; Next.js then redirects it.
 */
export function isAlwaysPublicPath(pathname: string): boolean {
	const path = pathname.length > 1 && pathname.endsWith("/") ? pathname.slice(0, -1) : pathname;
	return ALWAYS_PUBLIC.has(path) || path.startsWith("/legal/");
}
