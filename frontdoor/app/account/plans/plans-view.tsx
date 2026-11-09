/**
 * The plans screen (P4-03, P4-04, P4-05; PRD C2 req 1, 3, 4). Pure: it
 * renders a BillingView from GET /account/billing/state. Prices come only
 * from plans/index.ts. Forms post to the gateway's billing routes.
 *
 * Buy now skips Stripe Checkout, so its form states the charge, the renewal
 * and how to cancel, and needs a ticked box (California automatic renewal
 * law: clear terms and affirmative consent).
 */
import type { CSSProperties, ReactNode } from "react";
import type { BillingNotice, BillingView, BillingViewOn } from "../../../billing/view.ts";
import { discountedCents } from "../../../billing/view.ts";
import { formatUsd, type Plan, type Trial } from "../../../plans/index.ts";

const BILLING = "/account/billing";

const box: CSSProperties = { border: "1px solid #ccc", borderRadius: 8, padding: 16, margin: "12px 0" };
const notice: CSSProperties = { background: "#fff7e6", border: "1px solid #f0c36d", borderRadius: 8, padding: 12, margin: "12px 0" };

const usd = (cents: number) => formatUsd(cents / 100);
const every = (months: number) => (months === 1 ? "every month" : `every ${months} months`);

export function formatDay(iso: string | null): string {
	if (!iso) return "";
	return new Date(iso).toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric", timeZone: "UTC" });
}

function priceCents(plan: Plan, percentOff: number | null): number {
	return discountedCents(Math.round(plan.priceUsd * 100), percentOff);
}

function PriceText({ plan, percentOff }: { plan: Plan; percentOff: number | null }) {
	const list = Math.round(plan.priceUsd * 100);
	const now = priceCents(plan, percentOff);
	return (
		<span>
			{usd(now)} {every(plan.months)}
			{now !== list ? ` (${usd(list)} less your ${percentOff}% discount)` : null}
		</span>
	);
}

export const NOTICE_TEXT: Record<BillingNotice, string> = {
	finishing: "Finishing your sign-up. This takes a few seconds.",
	welcome: "You are all set. Open the tutor to start studying.",
	"trial-refused-card": "This card has already had a free trial. Nothing was charged. Choose a plan below to start now. Your card is charged today.",
	"trial-refused-email": "This email address has already had a free trial. Nothing was charged. Choose a plan below to start now. Your card is charged today.",
	"checkout-canceled": "Checkout was canceled. Nothing was charged.",
	"buy-now-pending": "Payment received. Switching your plan now.",
	bought: "Thank you. Your new plan has started.",
	"error-card": "Your card was not charged. Check your card under Manage billing, or try again.",
	"error-consent": "Tick the box to agree to automatic renewal before you buy.",
	"error-already-subscribed": "You already have a plan. Use Manage billing to change it.",
	"error-not-trialing": "Buy now is for the free trial. Use Manage billing to change your plan.",
	"error-unavailable": "Something went wrong and nothing was charged. Please try again in a minute.",
};

function ManageBilling() {
	return (
		<form method="post" action={`${BILLING}/portal`}>
			<button type="submit">Manage billing</button> <small>Change your card, see invoices, or cancel.</small>
		</form>
	);
}

/** "Subscribe": Stripe Checkout, charged today (no trial). */
function SubscribeForm({ plan }: { plan: Plan }) {
	return (
		<form method="post" action={`${BILLING}/checkout`}>
			<input type="hidden" name="plan" value={plan.id} />
			<button type="submit">Subscribe</button> <small>Charged today at Stripe Checkout. Promotion codes go there.</small>
		</form>
	);
}

function BuyNowForm({ plan, percentOff }: { plan: Plan; percentOff: number | null }) {
	const today = usd(priceCents(plan, percentOff));
	return (
		<form method="post" action={`${BILLING}/buy-now`}>
			<input type="hidden" name="plan" value={plan.id} />
			<p>
				Charged today: {today}. Your plan then renews automatically {every(plan.months)} at {today} until you cancel. You can cancel online at any time under Manage billing.
			</p>
			<p>
				<label>
					<input type="checkbox" name="agree" value="yes" required /> I agree to the <a href="/legal/terms">Terms</a> and to automatic renewal.
				</label>
			</p>
			<button type="submit">Buy now: {today} today</button>
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
					<h2 style={{ marginTop: 0 }}>Start your free trial</h2>
					<p>
						{trial.days} days, with up to {trial.studyHours} hours of study. A card is required. After the trial, the {trialPlan.name} plan is {usd(priceCents(trialPlan, null))} {every(trialPlan.months)} unless you cancel before the trial ends.
					</p>
					<form method="post" action={`${BILLING}/checkout`}>
						<input type="hidden" name="plan" value={trialPlan.id} />
						<button type="submit">Start {trial.days}-day free trial</button>
					</form>
					<p>
						<small>During the trial you can switch to a longer plan with Buy now. Have a North Aero or tester code? Enter it at Checkout.</small>
					</p>
				</section>
			) : (
				<p>Choose a plan to start studying.</p>
			);
		case "trialing":
			return (
				<p>
					Free trial: {view.trialStudyMinutes ?? 0} of {view.trialStudyLimitMinutes} minutes of study used. It ends on {formatDay(view.trialEndsAt)}. Then your card is charged for the{" "}
					{current?.name ?? "Monthly"} plan unless you cancel.
					{view.tester ? " Tester: no study limit." : ""}
				</p>
			);
		case "trial-used":
			return (
				<p role="alert">
					{view.trialUsedUp === "cost" ? "Your free trial has reached its usage limit." : "Your free trial's study time is used up."} Choose a plan below to keep studying. You can still read all of your chats and records.
				</p>
			);
		case "active":
			return (
				<p>
					Your plan: {current?.name ?? "active"}
					{view.tester ? " (tester, no charge)" : ""}. It renews on {formatDay(view.renewsAt)}.
				</p>
			);
		case "past-due":
			return <p role="alert">Your last payment did not go through. Stripe will try again. Update your card under Manage billing.</p>;
		case "canceling":
			return <p>Your plan ends on {formatDay(view.endsAt)}. You can study until then. To keep it, use Manage billing.</p>;
		case "unpaid":
			return <p role="alert">Your payments have stopped. Update your card under Manage billing to study again. Your chats and records are still here.</p>;
		case "ended":
			return (
				<p>
					Your plan has ended. You can still read and export your chats and records{view.retentionEndsAt ? ` until ${formatDay(view.retentionEndsAt)}` : ""}. Choose a plan to study again.
				</p>
			);
	}
}

export function PlansView({ view, plans, trial }: { view: BillingView | null; plans: readonly Plan[]; trial: Trial }) {
	return (
		<main style={{ maxWidth: 560, padding: 24, lineHeight: 1.5 }}>
			<h1>North Aero Ground Tutor</h1>
			<h2>Plans</h2>
			{view === null ? (
				<p>Loading your plan.</p>
			) : view.billing === "off" ? (
				<p>Plans are not available yet. Please check back soon.</p>
			) : (
				<PlansOn view={view} plans={plans} trial={trial} />
			)}
			<p>
				{/* A plain link on purpose: "/" is the tutor, served by the student's own server, not by this Next.js app. */}
				{/* eslint-disable-next-line @next/next/no-html-link-for-pages */}
				<a href="/">Open the tutor</a> · <a href="/help">Help</a> · <a href="/legal/terms">Terms</a>
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
					{view.plan === plan.id && !buyNow && view.status !== "ended" ? <p>Your current plan.</p> : null}
					{buyNow ? <BuyNowForm plan={plan} percentOff={percent} /> : null}
					{subscribe ? <SubscribeForm plan={plan} /> : null}
				</PlanCard>
			))}
			{view.canManageBilling ? <ManageBilling /> : null}
		</>
	);
}
