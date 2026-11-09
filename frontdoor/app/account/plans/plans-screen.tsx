"use client";

/**
 * Loads the plans screen's data from the gateway (GET /account/billing/state)
 * and renders it. While Stripe's webhook is on its way (after Checkout or
 * Buy now), it asks again every 2 seconds, up to a minute.
 */
import { useEffect, useState } from "react";
import type { BillingView } from "../../../billing/view.ts";
import type { Plan, Trial } from "../../../plans/index.ts";
import { PlansView } from "./plans-view.tsx";

const WAITING = new Set(["finishing", "buy-now-pending"]);

export function PlansScreen({ query, plans, trial }: { query: string; plans: readonly Plan[]; trial: Trial }) {
	const [view, setView] = useState<BillingView | null>(null);
	const [failed, setFailed] = useState(false);

	useEffect(() => {
		let stopped = false;
		let tries = 0;
		let timer: ReturnType<typeof setTimeout> | undefined;
		async function load() {
			try {
				const res = await fetch(`/account/billing/state${query}`, { cache: "no-store", credentials: "same-origin" });
				if (res.status === 401 || res.redirected) {
					window.location.href = `/account/sign-in?next=${encodeURIComponent("/account/plans")}`;
					return;
				}
				if (!res.ok) throw new Error(String(res.status));
				const next = (await res.json()) as BillingView;
				if (stopped) return;
				setView(next);
				tries += 1;
				if (next.billing === "on" && next.notice && WAITING.has(next.notice) && tries < 30) timer = setTimeout(load, 2000);
			} catch {
				if (!stopped) setFailed(true);
			}
		}
		void load();
		return () => {
			stopped = true;
			if (timer) clearTimeout(timer);
		};
	}, [query]);

	if (failed && !view) {
		return (
			<main style={{ maxWidth: 560, padding: 24 }}>
				<h1>North Aero Ground Tutor</h1>
				<p>Your plan could not be loaded. Please reload this page in a minute.</p>
			</main>
		);
	}
	return <PlansView view={view} plans={plans} trial={trial} />;
}
