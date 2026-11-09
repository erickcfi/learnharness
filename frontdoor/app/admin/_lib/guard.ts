import { headers } from "next/headers";
import { notFound } from "next/navigation";
import type { AdminIdentity } from "../../../admin/access.ts";
import { getAdminRuntime, type AdminRuntime } from "../../../admin/registry.ts";

/**
 * Each dashboard page's own check (C7 req 1: every admin route checks the
 * role on the server). The gateway has already refused anyone but the Owner
 * (admin/handler.ts); this checks the same login cookie and role again, so
 * a page can never render without both. Without the front door's runtime
 * (Next.js started alone), every page is "not found".
 */
export async function requireAdmin(): Promise<{ rt: AdminRuntime; who: AdminIdentity }> {
	const rt = getAdminRuntime();
	if (!rt?.ready) notFound();
	const who = await rt.identify((await headers()).get("cookie") ?? undefined);
	if (!who) notFound();
	return { rt, who };
}

/** The first value of a search param. */
export function param(value: string | string[] | undefined): string | undefined {
	return Array.isArray(value) ? value[0] : value;
}
