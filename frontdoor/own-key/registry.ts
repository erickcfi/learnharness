/**
 * How the /account/ai-key page (app/account/ai-key/) reaches the front
 * door's own-key service. The page runs in the same Node process, but
 * Next.js bundles it apart, so the front door puts one runtime on
 * globalThis at start (own-key/index.ts) and the page reads it here, as the
 * dashboard does (admin/registry.ts). Types and the slot only, so the page
 * bundle pulls in nothing else.
 */

/** What the page may know: on or off, and the saved key's last 4 characters. Never more of the key. */
export interface OwnKeyPageState {
	enabled: boolean;
	saved: { last4: string; savedAt: Date } | null;
}

export interface OwnKeyRuntime {
	/** The signed-in student's state, or null with no login. Throws when the store cannot be read. */
	state(cookieHeader: string | undefined): Promise<OwnKeyPageState | null>;
	/** Dates on the page use this time zone. */
	timeZone: string;
}

const SLOT = Symbol.for("northaero.frontdoor.ownKeyRuntime");

type Slot = { [SLOT]?: OwnKeyRuntime | null };

export function registerOwnKeyRuntime(runtime: OwnKeyRuntime | null): void {
	(globalThis as Slot)[SLOT] = runtime;
}

export function getOwnKeyRuntime(): OwnKeyRuntime | null {
	return (globalThis as Slot)[SLOT] ?? null;
}
