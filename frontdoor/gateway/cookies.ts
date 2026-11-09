/** Cookie parsing and writing for the front door. */

export function parseCookies(header: string | undefined): Map<string, string> {
	const jar = new Map<string, string>();
	if (!header) return jar;
	for (const part of header.split(";")) {
		const eq = part.indexOf("=");
		if (eq <= 0) continue;
		const name = part.slice(0, eq).trim();
		const raw = part.slice(eq + 1).trim();
		if (!name || jar.has(name)) continue;
		try {
			jar.set(name, decodeURIComponent(raw));
		} catch {
			jar.set(name, raw);
		}
	}
	return jar;
}

export interface CookieOptions {
	maxAgeSeconds: number;
	secure: boolean;
}

/** An HttpOnly, SameSite=Lax cookie for the whole site. */
export function serializeCookie(name: string, value: string, options: CookieOptions): string {
	return [`${name}=${encodeURIComponent(value)}`, "Path=/", `Max-Age=${options.maxAgeSeconds}`, "HttpOnly", "SameSite=Lax", ...(options.secure ? ["Secure"] : [])].join("; ");
}

export function clearCookie(name: string, secure: boolean): string {
	return serializeCookie(name, "", { maxAgeSeconds: 0, secure });
}

/** The front door's cookies and Clerk's. None of them may reach a tenant. */
export function isLoginCookie(name: string): boolean {
	return name === "fd_session" || name === "fd_age" || /^__(session|client_uat|clerk|refresh)/.test(name);
}

/** The Cookie header without login cookies, or undefined when none are left. */
export function stripLoginCookies(header: string | undefined): string | undefined {
	if (!header) return undefined;
	const kept = header
		.split(";")
		.map((part) => part.trim())
		.filter((part) => {
			const eq = part.indexOf("=");
			const name = (eq < 0 ? part : part.slice(0, eq)).trim();
			return name !== "" && !isLoginCookie(name);
		});
	return kept.length > 0 ? kept.join("; ") : undefined;
}
