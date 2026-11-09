/**
 * Billing emails the law needs and Stripe does not send (W2-8, PRD G2).
 *
 * California's automatic renewal law needs (1) an acknowledgment after
 * sign-up with the renewal terms and how to cancel, and (2) for a plan of a
 * year or longer, a notice 15 to 45 days before it renews. Stripe's docs
 * (read 2026-11-08) show no sign-up confirmation email, no receipt for a $0
 * trial invoice, and an "upcoming renewals" email that cannot be limited to
 * annual plans and is not documented to show the price. So the front door
 * sends both, through w2-email's EmailSender.
 *
 * Plain text, short sentences. Dates are written in UTC. The Owner approves
 * the wording with the legal documents (T5).
 */
import type { PlanId } from "../plans/index.ts";
import { formatUsd, PLANS, TRIAL } from "../plans/index.ts";
import { PLANS_PATH } from "./config.ts";
import type { EmailMessage } from "./hooks.ts";
import { discountedCents } from "./view.ts";

const TERMS_PATH = "/legal/terms";
const SUPPORT = "info@flynorthaero.com";

export function formatDate(date: Date): string {
	return date.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric", timeZone: "UTC" });
}

const usd = (cents: number) => formatUsd(Math.round(cents) / 100);

/** "every month", "every 3 months", "every 12 months". */
export function everyText(months: number): string {
	return months === 1 ? "every month" : `every ${months} months`;
}

function planFacts(planId: PlanId): { name: string; months: number; listCents: number } {
	const plan = PLANS.find((p) => p.id === planId);
	if (!plan) throw new Error(`No plan "${planId}"`);
	return { name: plan.name, months: plan.months, listCents: Math.round(plan.priceUsd * 100) };
}

export { discountedCents };

function priceLine(listCents: number, percentOff: number | null, months: number): string {
	const each = everyText(months);
	if (!percentOff) return `${usd(listCents)} ${each}`;
	return `${usd(discountedCents(listCents, percentOff))} ${each} (${usd(listCents)} less your ${percentOff}% discount)`;
}

function howToCancel(siteUrl: string): string[] {
	return [
		"How to cancel: sign in at",
		`${siteUrl}${PLANS_PATH}`,
		'and choose "Manage billing", then "Cancel plan". You can cancel online at any time.',
		"After you cancel, you keep the tutor until the end of the time you paid for.",
	];
}

function footer(siteUrl: string): string[] {
	return ["", `Terms: ${siteUrl}${TERMS_PATH}`, `Questions: write to ${SUPPORT}.`, "", "North Aero Ground Tutor"];
}

export interface ConfirmationInput {
	to: string;
	siteUrl: string;
	planId: PlanId;
	percentOff: number | null;
	/** Set when the subscription starts with the free trial. */
	trialEndsAt: Date | null;
	/** The next charge date (trial end, or the next renewal). */
	nextChargeAt: Date | null;
	/** Charged today, in cents, when this is a paid start or a Buy now. */
	chargedTodayCents: number | null;
	/** "start": a new subscription. "change": the plan changed (Buy now). */
	reason: "start" | "change";
}

/** The acknowledgment after sign-up or a plan change (California automatic renewal law). */
export function confirmationEmail(input: ConfirmationInput): EmailMessage {
	const plan = planFacts(input.planId);
	const lines: string[] = [];
	if (input.trialEndsAt) {
		const charge = discountedCents(plan.listCents, input.percentOff);
		lines.push(
			"Your free trial of North Aero Ground Tutor has started.",
			"",
			`Your trial lasts ${TRIAL.days} days and includes up to ${TRIAL.studyHours} hours of study.`,
			`On ${formatDate(input.trialEndsAt)}, your card will be charged ${usd(charge)} for the ${plan.name} plan, unless you cancel before then.`,
			`After that, your plan renews automatically at ${priceLine(plan.listCents, input.percentOff, plan.months)} until you cancel.`,
		);
	} else {
		lines.push(input.reason === "change" ? "Your North Aero Ground Tutor plan has changed." : "Thank you for subscribing to North Aero Ground Tutor.", "");
		lines.push(`Your plan: ${plan.name}, ${priceLine(plan.listCents, input.percentOff, plan.months)}.`);
		if (input.chargedTodayCents !== null) lines.push(`Charged today: ${usd(input.chargedTodayCents)}.`);
		if (input.nextChargeAt) lines.push(`Your plan renews automatically on ${formatDate(input.nextChargeAt)}, and ${everyText(plan.months)} after that, until you cancel.`);
		else lines.push(`Your plan renews automatically ${everyText(plan.months)} until you cancel.`);
	}
	lines.push("", ...howToCancel(input.siteUrl), ...footer(input.siteUrl));
	return {
		to: input.to,
		kind: "billing-confirmation",
		subject: input.trialEndsAt ? "Your North Aero Ground Tutor trial has started" : "Your North Aero Ground Tutor plan",
		text: lines.join("\n"),
	};
}

export interface RenewalNoticeInput {
	to: string;
	siteUrl: string;
	/** What Stripe will charge, in cents (after any discount). */
	amountCents: number;
	renewsAt: Date;
	months: number;
}

/** The notice 15 to 45 days before a plan of a year or longer renews (California automatic renewal law). */
export function renewalNoticeEmail(input: RenewalNoticeInput): EmailMessage {
	const date = formatDate(input.renewsAt);
	const lines = [
		`Your North Aero Ground Tutor plan renews automatically on ${date}.`,
		"",
		`On that day your card will be charged ${usd(input.amountCents)} for the next ${input.months} months.`,
		"If you want to keep studying, you need to do nothing.",
		"",
		"To stop the renewal, cancel before that date.",
		...howToCancel(input.siteUrl),
		...footer(input.siteUrl),
	];
	return { to: input.to, kind: "annual-renewal-notice", subject: `Your plan renews on ${date}`, text: lines.join("\n") };
}
