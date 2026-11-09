/**
 * Email address checks for the report address (C6 req 3: any address is
 * allowed, D20) and the Owner alert address. Plain on purpose: one address,
 * no display name, no spaces, no line breaks (so it can never inject a
 * header), at most 254 characters (RFC 5321).
 */

const ADDRESS = /^[^\s@<>()[\]\\,;:"]+@[^\s@<>()[\]\\,;:"]+\.[^\s@<>()[\]\\,;:".]{2,}$/;

export function isValidEmailAddress(value: string): boolean {
	if (value.length === 0 || value.length > 254) return false;
	if (/[\r\n\0]/.test(value)) return false;
	const at = value.lastIndexOf("@");
	if (at < 1 || at > 64) return false;
	return ADDRESS.test(value);
}

/** Trimmed, with the domain in lower case. Null when it is not one valid address. */
export function normalizeEmailAddress(value: string | null | undefined): string | null {
	const trimmed = (value ?? "").trim();
	if (!isValidEmailAddress(trimmed)) return null;
	const at = trimmed.lastIndexOf("@");
	return `${trimmed.slice(0, at)}@${trimmed.slice(at + 1).toLowerCase()}`;
}
