/**
 * Sealing a student's own Anthropic key (2026-11-13,
 * docs/decisions/2026-11-13-own-ai-key.md).
 *
 * AES-256-GCM with a 32-byte secret from the Railway variable
 * LH_OWN_KEY_SECRET (base64). Each key gets a fresh 12-byte nonce. The
 * tenant id is bound in as associated data, so a sealed key copied to
 * another tenant's row cannot be opened. Only the last 4 characters stay in
 * clear. Errors never carry the key or the secret.
 *
 * Framework-free and runnable by plain Node (type stripping).
 */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/** The Railway variable that holds the encryption secret. Unset or empty: own keys are off. */
export const OWN_KEY_SECRET_ENV = "LH_OWN_KEY_SECRET";

const SECRET_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;

type Env = Readonly<Record<string, string | undefined>>;

export interface SealedKey {
	ciphertext: Buffer;
	iv: Buffer;
	tag: Buffer;
	/** The key's last 4 characters. */
	last4: string;
}

/** The secret's bytes, or null when the text is not 32 bytes of base64 (or base64url). */
function decodeSecret(text: string): Buffer | null {
	const value = text.trim();
	if (!/^[A-Za-z0-9+/_-]+={0,2}$/.test(value)) return null;
	const bytes = Buffer.from(value, /[-_]/.test(value) ? "base64url" : "base64");
	return bytes.length === SECRET_BYTES ? bytes : null;
}

/** The start check's message for a malformed secret, or null. Never prints the value. */
export function ownKeyEnvProblem(env: Env): string | null {
	const value = env[OWN_KEY_SECRET_ENV];
	if (value === undefined || value === "") return null;
	return decodeSecret(value)
		? null
		: `${OWN_KEY_SECRET_ENV} must be 32 random bytes in base64 (for example: openssl rand -base64 32). Leave it unset to keep own AI keys off.`;
}

/** A start check (wiring/env.ts): a set but malformed secret stops the start. */
export function assertOwnKeyEnv(env: Env): void {
	const problem = ownKeyEnvProblem(env);
	if (problem) throw new Error(problem);
}

/** The secret, or null when unset (own keys off). Throws on a malformed value, as the start check does. */
export function ownKeySecretFrom(env: Env): Buffer | null {
	const value = env[OWN_KEY_SECRET_ENV];
	if (value === undefined || value === "") return null;
	const secret = decodeSecret(value);
	if (!secret) throw new Error(ownKeyEnvProblem(env) ?? `${OWN_KEY_SECRET_ENV} is not valid.`);
	return secret;
}

const associatedData = (tenantId: string) => Buffer.from(`north-aero:own-ai-key:v1:anthropic:${tenantId}`, "utf8");

export function sealOwnKey(secret: Buffer, tenantId: string, apiKey: string): SealedKey {
	const iv = randomBytes(IV_BYTES);
	const cipher = createCipheriv("aes-256-gcm", secret, iv, { authTagLength: TAG_BYTES });
	cipher.setAAD(associatedData(tenantId));
	const ciphertext = Buffer.concat([cipher.update(apiKey, "utf8"), cipher.final()]);
	return { ciphertext, iv, tag: cipher.getAuthTag(), last4: apiKey.slice(-4) };
}

/** The saved key cannot be opened: another secret, another tenant, or changed bytes. */
export class OwnKeyUnreadableError extends Error {
	constructor() {
		super("the saved own AI key could not be decrypted");
		this.name = "OwnKeyUnreadableError";
	}
}

export function openOwnKey(secret: Buffer, tenantId: string, sealed: Pick<SealedKey, "ciphertext" | "iv" | "tag">): string {
	try {
		const decipher = createDecipheriv("aes-256-gcm", secret, sealed.iv, { authTagLength: TAG_BYTES });
		decipher.setAAD(associatedData(tenantId));
		decipher.setAuthTag(sealed.tag);
		return Buffer.concat([decipher.update(sealed.ciphertext), decipher.final()]).toString("utf8");
	} catch {
		throw new OwnKeyUnreadableError();
	}
}

/**
 * The pasted text as an Anthropic API key, or null. Only Console API keys
 * (sk-ant-api03-...) are taken: Claude subscription tokens (sk-ant-oat...)
 * and Admin keys are not, since signing in with a subscription waits on a
 * terms check (master, 2026-11-13).
 */
export function anthropicApiKeyFrom(text: string): string | null {
	const key = text.trim();
	return /^sk-ant-api\d{2}-[A-Za-z0-9_-]{20,250}$/.test(key) ? key : null;
}
