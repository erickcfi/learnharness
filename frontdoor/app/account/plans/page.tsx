import { PLANS, TRIAL } from "../../../plans/index.ts";
import { PlansScreen } from "./plans-screen.tsx";

export const metadata = { title: "Plans | North Aero Ground Tutor" };

const PASSED = ["checkout", "bought", "error", "reason"] as const;

/**
 * The plans screen (W2-8, PRD C2). A new student lands here after the 18+
 * box; the trial gate sends students here when the trial's study time is
 * used up. The data comes from the gateway (GET /account/billing/state), so
 * this page needs no database access.
 */
export default async function PlansPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
	const params = await searchParams;
	const query = new URLSearchParams();
	for (const name of PASSED) {
		const value = params[name];
		if (typeof value === "string" && /^[A-Za-z0-9_-]{1,200}$/.test(value)) query.set(name, value);
	}
	const qs = query.toString();
	return <PlansScreen query={qs ? `?${qs}` : ""} plans={PLANS} trial={TRIAL} />;
}
