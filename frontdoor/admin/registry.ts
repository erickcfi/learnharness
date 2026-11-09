/**
 * How the dashboard's Next.js pages (app/admin/) reach the front door's
 * data. The pages run in the same Node process as the front door
 * (server.ts), but Next.js bundles them separately, so module state is not
 * shared. The front door puts one AdminRuntime on globalThis at start
 * (admin/wiring.ts); the pages read it here. Without it (for example
 * `next dev` alone, with no front door), every admin page refuses.
 *
 * Types only, plus the globalThis slot, so the page bundle pulls in nothing
 * else from the front door.
 */
import type { OwnerSettings } from "../db/index.ts";
import type { LibraryFile } from "../library/store.ts";
import type { AdminIdentity } from "./access.ts";
import type { Overview } from "./overview.ts";
import type { PeriodKey } from "./period.ts";
import type { StudentDetail } from "./student.ts";

/** `text` is null when consent is active but the tenant's server could not give the session. */
export type SessionTextView = { allowed: false } | { allowed: true; text: string | null };

export interface AdminRuntime {
	timeZone: string;
	/** Re-checks the login cookie and the Owner role (the gateway already did; this is the page's own check). */
	identify(cookieHeader: string | undefined): Promise<AdminIdentity | null>;
	overview(period: PeriodKey): Promise<Overview>;
	student(tenantId: string, period: PeriodKey): Promise<StudentDetail | null>;
	/** Consent checked inside, on every call (D19). */
	sessionText(tenantId: string, chatId: string): Promise<SessionTextView>;
	thresholds(): Promise<OwnerSettings>;
	library(): Promise<LibraryFile[]>;
	/** For the student's own /account/sharing page: their switch and when it last changed, or null with no login. */
	studentSharing(cookieHeader: string | undefined): Promise<{ optedIn: boolean; changedAt: Date | null } | null>;
	/** True when the database is connected; the dashboard needs it. */
	ready: boolean;
}

const SLOT = Symbol.for("northaero.frontdoor.adminRuntime");

type Slot = { [SLOT]?: AdminRuntime | null };

export function registerAdminRuntime(runtime: AdminRuntime | null): void {
	(globalThis as Slot)[SLOT] = runtime;
}

export function getAdminRuntime(): AdminRuntime | null {
	return (globalThis as Slot)[SLOT] ?? null;
}
