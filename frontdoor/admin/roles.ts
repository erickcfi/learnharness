/**
 * Who may do what on the dashboard (P3-01, C7 req 1, D27).
 *
 * Roles live in the tutor's database (account_roles). An account with no
 * role is a student and gets nothing here. At launch only the Owner has
 * permissions; Staff exists so the Owner can grant it some later, by
 * adding to its list below. Every admin route checks one permission on the
 * server, in frontdoor/admin/handler.ts.
 */
import type { Role } from "../db/index.ts";

export const PERMISSIONS = [
	"dashboard.view",
	"tenants.pause",
	"alerts.clear",
	"settings.edit",
	"library.manage",
	"consents.record",
	"sessionText.read",
] as const;
export type Permission = (typeof PERMISSIONS)[number];

export const ROLE_PERMISSIONS: Readonly<Record<Role, readonly Permission[]>> = {
	owner: PERMISSIONS,
	// D27: Staff launches with nothing. The Owner decides later what to add.
	staff: [],
};

export function can(roles: readonly Role[], permission: Permission): boolean {
	return roles.some((role) => ROLE_PERMISSIONS[role]?.includes(permission) ?? false);
}
