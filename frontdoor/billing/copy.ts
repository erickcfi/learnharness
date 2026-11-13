/**
 * Every sentence billing shows or sends a student (W2-8), in one place for
 * the Owner's review (master, 2026-11-08). The legal documents (T5) must
 * agree with it. Prices come only from plans/index.ts; no amount is written
 * here.
 *
 * Plain, short sentences. No em dashes. Dates in the school's time zone.
 */
import { formatUsd, type Plan, type Trial } from "../plans/index.ts";
// The school's zone. w2-pause exports the same value as SCHOOL_TIME_ZONE (pause/copy.ts); unify at merge.
import { REPORT_TIME_ZONE } from "../reports/time.ts";
import { PLANS_PATH } from "./config.ts";
import type { BillingNotice } from "./view.ts";

/** America/Los_Angeles: North Aero is at the Salinas Airport (KSNS), California (master, 2026-11-08). */
export const SCHOOL_TIME_ZONE = REPORT_TIME_ZONE;

/** "November 16, 2026", in the school's time zone. */
export function formatDay(date: Date | string | null): string {
	if (date === null) return "";
	return new Date(date).toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric", timeZone: SCHOOL_TIME_ZONE });
}

export const usd = (cents: number) => formatUsd(Math.round(cents) / 100);

/** "every month", "every 3 months", "every 12 months". */
export function everyText(months: number): string {
	return months === 1 ? "every month" : `every ${months} months`;
}

/** "<price> every 12 months (<list price> less your 20% discount)". */
export function priceLine(listCents: number, chargeCents: number, percentOff: number | null, months: number): string {
	const each = everyText(months);
	return chargeCents === listCents || !percentOff ? `${usd(chargeCents)} ${each}` : `${usd(chargeCents)} ${each} (${usd(listCents)} less your ${percentOff}% discount)`;
}

export const TERMS_PATH = "/legal/terms";
export const SUPPORT_EMAIL = "info@flynorthaero.com";

// ---- Stripe Checkout ----

/** Next to the terms box at Checkout (consent_collection; California automatic renewal law). */
export function checkoutTermsText(origin: string, months: number): string {
	return `I agree to the [Terms](${origin}${TERMS_PATH}). My plan renews automatically ${everyText(months)} until I cancel. I can cancel online at any time.`;
}

// ---- the tutor, when a request is refused (upstream shows it as "Something went wrong: ...") ----

export const REFUSALS = {
	trialUsed: (plansUrl: string) => `Your free trial's study time is used up. Choose a plan to keep studying: ${plansUrl}`,
	planEnded: (plansUrl: string) => `Your plan has ended. Choose a plan to study again: ${plansUrl}`,
	unpaid: (plansUrl: string) => `Your last payment did not go through. Update your card under Manage billing: ${plansUrl}`,
	noPlan: (plansUrl: string) => `Choose a plan to start studying: ${plansUrl}`,
};

// ---- the plans screen (app/account/plans) ----

export const PLANS_SCREEN = {
	title: "Plans | North Aero Ground Tutor",
	brand: "North Aero Ground Tutor",
	heading: "Plans",
	loading: "Loading your plan.",
	off: "Plans are not available yet. Please check back soon.",
	failed: "Your plan could not be loaded. Please reload this page in a minute.",
	links: { tutor: "Open the tutor", help: "Help", terms: "Terms", ownKey: "Your own AI key" },
	trialHeading: "Start your free trial",
	trialOffer: (trial: Trial, plan: Plan, priceCents: number) =>
		`${trial.days} days, with up to ${trial.studyHours} hours of study. A card is required. After the trial, the ${plan.name} plan is ${usd(priceCents)} ${everyText(plan.months)} unless you cancel before the trial ends.`,
	trialButton: (trial: Trial) => `Start ${trial.days}-day free trial`,
	trialNote: "During the trial you can switch to a longer plan with Buy now. Have a North Aero or tester code? Enter it at Checkout.",
	choose: "Choose a plan to start studying.",
	trialing: (minutesUsed: number, minutesLimit: number, endsOn: string, planName: string, tester: boolean) =>
		`Free trial: ${minutesUsed} of ${minutesLimit} minutes of study used. It ends on ${endsOn}. Then your card is charged for the ${planName} plan unless you cancel.${tester ? " Tester: no study limit." : ""}`,
	trialUsed: (byCost: boolean) =>
		`${byCost ? "Your free trial has reached its usage limit." : "Your free trial's study time is used up."} Choose a plan below to keep studying. You can still read all of your chats and records.`,
	active: (planName: string, tester: boolean, renewsOn: string) => `Your plan: ${planName}${tester ? " (tester, no charge)" : ""}. It renews on ${renewsOn}.`,
	pastDue: "Your last payment did not go through. Stripe will try again. Update your card under Manage billing.",
	canceling: (endsOn: string) => `Your plan ends on ${endsOn}. You can study until then. To keep it, use Manage billing.`,
	unpaid: "Your payments have stopped. Update your card under Manage billing to study again. Your chats and records are still here.",
	ended: (keptUntil: string | null) => `Your plan has ended. You can still read and export your chats and records${keptUntil ? ` until ${keptUntil}` : ""}. Choose a plan to study again.`,
	current: "Your current plan.",
	subscribe: "Subscribe",
	subscribeNote: "Charged today at Stripe Checkout. Promotion codes go there.",
	buyNowTerms: (today: string, months: number) =>
		`Charged today: ${today}. Your plan then renews automatically ${everyText(months)} at ${today} until you cancel. You can cancel online at any time under Manage billing.`,
	buyNowAgree: { before: "I agree to the ", terms: "Terms", after: " and to automatic renewal." },
	buyNowButton: (today: string) => `Buy now: ${today} today`,
	manageBilling: "Manage billing",
	manageBillingNote: "Change your card, see invoices, or cancel.",
	discount: (listCents: number, percentOff: number) => ` (${usd(listCents)} less your ${percentOff}% discount)`,
};

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

// ---- w2-pause's screens (wired by the master at merge) ----

/**
 * "Trial used up" in w2-pause's interstitial shape (pause/interstitial.ts
 * ScreenContent), for "/" if the master wires it. The "Read your sessions"
 * href is w2-pause's READ_PATH.
 */
export function trialUsedScreen(readPath: string) {
	return {
		title: "Free trial used up",
		heading: "Your free trial's study time is used up",
		lead: "Choose a plan to keep studying.",
		paragraphs: ["You can still read all of your chats and records. Buy now on the plans page starts your plan today, with nothing lost."],
		actions: [
			{ label: "See plans", href: PLANS_PATH, primary: true },
			{ label: "Read your sessions", href: readPath },
		],
	};
}

/** For w2-pause's plan-ended screen (pause/copy.ts RETENTION_EXTRA_ACTIONS). */
export const SUBSCRIBE_AGAIN_ACTION = { label: "Subscribe again", href: PLANS_PATH } as const;

// ---- emails (billing/emails.ts) ----

export const EMAILS = {
	brand: "North Aero Ground Tutor",
	cancelHeading: "How to cancel",
	cancelSteps: (siteUrl: string) => `Sign in at ${siteUrl}${PLANS_PATH} and choose "Manage billing", then "Cancel plan". You can cancel online at any time.`,
	cancelAfter: "After you cancel, you keep the tutor until the end of the time you paid for.",
	footerLinks: { plans: "Plans and billing", terms: "Terms" },
	questions: `Questions: write to ${SUPPORT_EMAIL}.`,
	trial: {
		subject: "Your North Aero Ground Tutor trial has started",
		title: "Your free trial has started",
		length: (trial: Trial) => `Your trial lasts ${trial.days} days and includes up to ${trial.studyHours} hours of study.`,
		charge: (on: string, chargeCents: number, planName: string) => `On ${on}, your card will be charged ${usd(chargeCents)} for the ${planName} plan, unless you cancel before then.`,
		renews: (price: string) => `After that, your plan renews automatically at ${price} until you cancel.`,
	},
	paid: {
		subject: "Your North Aero Ground Tutor plan",
		title: "Thank you for subscribing",
	},
	changed: {
		subject: "Your North Aero Ground Tutor plan has changed",
		title: "Your plan has changed",
	},
	rows: { plan: "Plan", chargedToday: "Charged today", nextCharge: "Next charge" },
	renewsEvery: (months: number) => `Your plan renews automatically ${everyText(months)} until you cancel.`,
	renewal: {
		subject: (on: string) => `Your plan renews on ${on}`,
		title: "Your plan renews soon",
		first: (on: string) => `Your North Aero Ground Tutor plan renews automatically on ${on}.`,
		charge: (amountCents: number, months: number) => `On that day your card will be charged ${usd(amountCents)} for the next ${months} months. If you want to keep studying, you need to do nothing.`,
		stop: "To stop the renewal, cancel before that date.",
	},
};
