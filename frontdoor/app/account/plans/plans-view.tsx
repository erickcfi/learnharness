/**
 * The plans screen (P4-03, P4-04, P4-05; PRD C2 req 1, 3, 4). Pure: it
 * renders a BillingView from GET /account/billing/state. Prices come only
 * from plans/index.ts; the words from billing/copy.ts. Forms post to the
 * gateway's billing routes. Dates are in the school's time zone.
 *
 * Buy now skips Stripe Checkout, so its form states the charge, the renewal
 * and how to cancel, and needs a ticked box (California automatic renewal
 * law: clear terms and affirmative consent).
 */
import type { CSSProperties, ReactNode } from "react";
import { formatDay, NOTICE_TEXT, PLANS_SCREEN as T, TERMS_PATH, usd } from "../../../billing/copy.ts";
import type { BillingView, BillingViewOn } from "../../../billing/view.ts";
import { discountedCents } from "../../../billing/view.ts";
import type { Plan, Trial } from "../../../plans/index.ts";

export { NOTICE_TEXT };

const BILLING = "/account/billing";

const box: CSSProperties = { border: "1px solid #ccc", borderRadius: 8, padding: 16, margin: "12px 0" };
const notice: CSSProperties = { background: "#fff7e6", border: "1px solid #f0c36d", borderRadius: 8, padding: 12, margin: "12px 0" };

const every = (months: number) => (months === 1 ? "every month" : `every ${months} months`);
const listCents = (plan: Plan) => Math.round(plan.priceUsd * 100);
const priceCents = (plan: Plan, percentOff: number | null) => discountedCents(listCents(plan), percentOff);

function PriceText({ plan, percentOff }: { plan: Plan; percentOff: number | null }) {
	const now = priceCents(plan, percentOff);
	return (
		<span>
			{usd(now)} {every(plan.months)}
			{now !== listCents(plan) && percentOff ? T.discount(listCents(plan), percentOff) : null}
		</span>
	);
}

function ManageBilling() {
	return (
		<form method="post" action={`${BILLING}/portal`}>
			<button type="submit">{T.manageBilling}</button> <small>{T.manageBillingNote}</small>
		</form>
	);
}

/** "Subscribe": Stripe Checkout, charged today (no trial). */
function SubscribeForm({ plan }: { plan: Plan }) {
	return (
		<form method="post" action={`${BILLING}/checkout`}>
			<input type="hidden" name="plan" value={plan.id} />
			<button type="submit">{T.subscribe}</button> <small>{T.subscribeNote}</small>
		</form>
	);
}

function BuyNowForm({ plan, percentOff }: { plan: Plan; percentOff: number | null }) {
	const today = usd(priceCents(plan, percentOff));
	return (
		<form method="post" action={`${BILLING}/buy-now`}>
			<input type="hidden" name="plan" value={plan.id} />
			<p>{T.buyNowTerms(today, plan.months)}</p>
			<p>
				<label>
					<input type="checkbox" name="agree" value="yes" required /> {T.buyNowAgree.before}
					<a href={TERMS_PATH}>{T.buyNowAgree.terms}</a>
					{T.buyNowAgree.after}
				</label>
			</p>
			<button type="submit">{T.buyNowButton(today)}</button>
		</form>
	);
}

function PlanCard({ plan, percentOff, children }: { plan: Plan; percentOff: number | null; children?: ReactNode }) {
	return (
		<section style={box} aria-label={plan.name}>
			<h3 style={{ margin: "0 0 4px" }}>{plan.name}</h3>
			<p style={{ margin: "0 0 8px" }}>
				<PriceText plan={plan} percentOff={percentOff} />
			</p>
			{children}
		</section>
	);
}

function Status({ view, trial, plans }: { view: BillingViewOn; trial: Trial; plans: readonly Plan[] }) {
	const current = plans.find((p) => p.id === view.plan);
	const trialPlan = plans.find((p) => p.id === trial.convertsTo);
	switch (view.status) {
		case "none":
			return view.trialEligible && trialPlan ? (
				<section style={box}>
					<h2 style={{ marginTop: 0 }}>{T.trialHeading}</h2>
					<p>{T.trialOffer(trial, trialPlan, priceCents(trialPlan, null))}</p>
					<form method="post" action={`${BILLING}/checkout`}>
						<input type="hidden" name="plan" value={trialPlan.id} />
						<button type="submit">{T.trialButton(trial)}</button>
					</form>
					<p>
						<small>{T.trialNote}</small>
					</p>
				</section>
			) : (
				<p>{T.choose}</p>
			);
		case "trialing":
			return <p>{T.trialing(view.trialStudyMinutes ?? 0, view.trialStudyLimitMinutes, formatDay(view.trialEndsAt), current?.name ?? trialPlan?.name ?? "", view.tester)}</p>;
		case "trial-used":
			return <p role="alert">{T.trialUsed(view.trialUsedUp === "cost")}</p>;
		case "active":
			return <p>{T.active(current?.name ?? "", view.tester, formatDay(view.renewsAt))}</p>;
		case "past-due":
			return <p role="alert">{T.pastDue}</p>;
		case "canceling":
			return <p>{T.canceling(formatDay(view.endsAt))}</p>;
		case "unpaid":
			return <p role="alert">{T.unpaid}</p>;
		case "ended":
			return <p>{T.ended(view.retentionEndsAt ? formatDay(view.retentionEndsAt) : null)}</p>;
	}
}

export function PlansView({ view, plans, trial }: { view: BillingView | null; plans: readonly Plan[]; trial: Trial }) {
	return (
		<main style={{ maxWidth: 560, padding: 24, lineHeight: 1.5 }}>
			<h1>{T.brand}</h1>
			<h2>{T.heading}</h2>
			{view === null ? <p>{T.loading}</p> : view.billing === "off" ? <p>{T.off}</p> : <PlansOn view={view} plans={plans} trial={trial} />}
			<p>
				{/* A plain link on purpose: "/" is the tutor, served by the student's own server, not by this Next.js app. */}
				{/* eslint-disable-next-line @next/next/no-html-link-for-pages */}
				<a href="/">{T.links.tutor}</a> · <a href="/help">{T.links.help}</a> · <a href={TERMS_PATH}>{T.links.terms}</a>
			</p>
		</main>
	);
}

function PlansOn({ view, plans, trial }: { view: BillingViewOn; plans: readonly Plan[]; trial: Trial }) {
	const buyNow = view.status === "trialing" || view.status === "trial-used";
	const subscribe = (view.status === "none" && !view.trialEligible) || view.status === "ended";
	const percent = view.discountPercent;
	return (
		<>
			{view.notice ? (
				<p style={notice} role="status">
					{NOTICE_TEXT[view.notice]}
				</p>
			) : null}
			<Status view={view} trial={trial} plans={plans} />
			{plans.map((plan) => (
				<PlanCard key={plan.id} plan={plan} percentOff={buyNow ? percent : null}>
					{view.plan === plan.id && !buyNow && view.status !== "ended" ? <p>{T.current}</p> : null}
					{buyNow ? <BuyNowForm plan={plan} percentOff={percent} /> : null}
					{subscribe ? <SubscribeForm plan={plan} /> : null}
				</PlanCard>
			))}
			{view.canManageBilling ? <ManageBilling /> : null}
		</>
	);
}
