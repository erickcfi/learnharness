/**
 * Where to send the browser after a login or a form: a path on this site,
 * never another site. "//evil.example" and "/\evil.example" are other sites
 * to a browser, so they are refused.
 */
export const FRONT_DOOR_PREFIX = "/account";

const isUnder = (pathname: string, prefix: string) => pathname === prefix || pathname.startsWith(`${prefix}/`);

export function safeReturnPath(raw: string | null | undefined, fallback: string, options: { within?: string } = {}): string {
	if (!raw || !raw.startsWith("/") || raw.startsWith("//") || raw.includes("\\")) return fallback;
	let url: URL;
	try {
		url = new URL(raw, "http://front.door");
	} catch {
		return fallback;
	}
	if (url.origin !== "http://front.door") return fallback;
	const result = `${url.pathname}${url.search}`;
	if (result.startsWith("//")) return fallback;
	if (options.within) return isUnder(url.pathname, options.within) ? result : fallback;
	return isUnder(url.pathname, FRONT_DOOR_PREFIX) ? fallback : result;
}
