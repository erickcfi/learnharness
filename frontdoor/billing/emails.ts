/**
 * Billing emails the law needs and Stripe does not send (W2-8, PRD G2).
 *
 * California's automatic renewal law needs (1) an acknowledgment after
 * sign-up with the renewal terms and how to cancel, and (2) for a plan of a
 * year or longer, a notice 15 to 45 days before it renews. Stripe's docs
 * (read 2026-11-08) show no sign-up confirmation email, no receipt for a $0
 * trial invoice, and an "upcoming renewals" email that cannot be limited to
 * annual plans and is not documented to show the price. So the front door
 * sends both, through w2-email's sender (same SES identity, From and
 * Reply-To as the report emails) and w2-email's layout.
 *
 * Short sentences. Dates are written in UTC. The Owner approves the wording
 * with the legal documents (T5).
 */
import { type Block, type EmailDocument, renderEmailHtml, renderEmailText } from "../email/layout.ts";
import type { EmailMessage } from "../email/sender.ts";
import { CONTACT_EMAIL } from "../marketing/site.ts";
import { formatUsd, type PlanId, PLANS, TRIAL } from "../plans/index.ts";
import { PLANS_PATH } from "./config.ts";
import { discountedCents } from "./view.ts";

export { discountedCents };

const TERMS_PATH = "/legal/terms";

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

function priceLine(listCents: number, percentOff: number | null, months: number): string {
	const each = everyText(months);
	if (!percentOff) return `${usd(listCents)} ${each}`;
	return `${usd(discountedCents(listCents, percentOff))} ${each} (${usd(listCents)} less your ${percentOff}% discount)`;
}

const p = (text: string): Block => ({ kind: "paragraph", text });

function howToCancel(siteUrl: string): Block[] {
	return [
		{ kind: "heading", text: "How to cancel" },
		p(`Sign in at ${siteUrl}${PLANS_PATH} and choose "Manage billing", then "Cancel plan". You can cancel online at any time.`),
		p("After you cancel, you keep the tutor until the end of the time you paid for."),
	];
}

function documentMessage(kind: EmailMessage["kind"], to: string, tenantId: string | undefined, subject: string, doc: EmailDocument): EmailMessage {
	return { kind, to, subject, text: renderEmailText(doc), html: renderEmailHtml(doc), ...(tenantId ? { tenantId } : {}) };
}

function footer(siteUrl: string): EmailDocument["footer"] {
	return {
		links: [
			{ text: "Plans and billing", href: `${siteUrl}${PLANS_PATH}` },
			{ text: "Terms", href: `${siteUrl}${TERMS_PATH}` },
		],
		lines: [`Questions: write to ${CONTACT_EMAIL}.`, "North Aero Ground Tutor"],
	};
}

export interface ConfirmationInput {
	to: string;
	tenantId?: string;
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
	const blocks: Block[] = [];
	let title: string;
	if (input.trialEndsAt) {
		title = "Your free trial has started";
		const charge = discountedCents(plan.listCents, input.percentOff);
		blocks.push(
			p(`Your trial lasts ${TRIAL.days} days and includes up to ${TRIAL.studyHours} hours of study.`),
			p(`On ${formatDate(input.trialEndsAt)}, your card will be charged ${usd(charge)} for the ${plan.name} plan, unless you cancel before then.`),
			p(`After that, your plan renews automatically at ${priceLine(plan.listCents, input.percentOff, plan.months)} until you cancel.`),
		);
	} else {
		title = input.reason === "change" ? "Your plan has changed" : "Thank you for subscribing";
		const rows: { label: string; value: string }[] = [{ label: "Plan", value: `${plan.name}, ${priceLine(plan.listCents, input.percentOff, plan.months)}` }];
		if (input.chargedTodayCents !== null) rows.push({ label: "Charged today", value: usd(input.chargedTodayCents) });
		if (input.nextChargeAt) rows.push({ label: "Next charge", value: formatDate(input.nextChargeAt) });
		blocks.push({ kind: "rows", rows }, p(`Your plan renews automatically ${everyText(plan.months)} until you cancel.`));
	}
	blocks.push(...howToCancel(input.siteUrl));
	const subject = input.trialEndsAt ? "Your North Aero Ground Tutor trial has started" : input.reason === "change" ? "Your North Aero Ground Tutor plan has changed" : "Your North Aero Ground Tutor plan";
	return documentMessage("billing-confirmation", input.to, input.tenantId, subject, { title, preheader: blocks[0]?.kind === "paragraph" ? blocks[0].text : title, blocks, footer: footer(input.siteUrl) });
}

export interface RenewalNoticeInput {
	to: string;
	tenantId?: string;
	siteUrl: string;
	/** What Stripe will charge, in cents (after any discount). */
	amountCents: number;
	renewsAt: Date;
	months: number;
}

/** The notice 15 to 45 days before a plan of a year or longer renews (California automatic renewal law). */
export function renewalNoticeEmail(input: RenewalNoticeInput): EmailMessage {
	const date = formatDate(input.renewsAt);
	const first = `Your North Aero Ground Tutor plan renews automatically on ${date}.`;
	const blocks: Block[] = [
		p(first),
		p(`On that day your card will be charged ${usd(input.amountCents)} for the next ${input.months} months. If you want to keep studying, you need to do nothing.`),
		p("To stop the renewal, cancel before that date."),
		...howToCancel(input.siteUrl),
	];
	return documentMessage("annual-renewal-notice", input.to, input.tenantId, `Your plan renews on ${date}`, { title: "Your plan renews soon", preheader: first, blocks, footer: footer(input.siteUrl) });
}
