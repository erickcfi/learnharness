/**
 * Billing emails the law needs and Stripe does not send (W2-8, PRD G2).
 *
 * California's automatic renewal law needs (1) an acknowledgment after
 * sign-up with the renewal terms and how to cancel, and (2) for a plan of a
 * year or longer, a notice 15 to 45 days before it renews. Stripe's docs
 * (read 2026-11-08) show no sign-up confirmation email, no receipt for a $0
 * trial invoice, and an "upcoming renewals" email that cannot be limited to
 * annual plans and is not documented to show the price. So the front door
 * sends both, through w2-email's sender and layout, from
 * billing@ground.flynorthaero.com with Reply-To info@ (master, 2026-11-08).
 *
 * The wording is in billing/copy.ts. Dates in the school's time zone.
 */
import { type Block, type EmailDocument, renderEmailHtml, renderEmailText } from "../email/layout.ts";
import type { EmailMessage } from "../email/sender.ts";
import { type PlanId, PLANS, TRIAL } from "../plans/index.ts";
import { PLANS_PATH } from "./config.ts";
import { EMAILS, formatDay, priceLine, TERMS_PATH, usd } from "./copy.ts";
import { discountedCents } from "./view.ts";

export { discountedCents };

function planFacts(planId: PlanId): { name: string; months: number; listCents: number } {
	const plan = PLANS.find((p) => p.id === planId);
	if (!plan) throw new Error(`No plan "${planId}"`);
	return { name: plan.name, months: plan.months, listCents: Math.round(plan.priceUsd * 100) };
}

const p = (text: string): Block => ({ kind: "paragraph", text });

function howToCancel(siteUrl: string): Block[] {
	return [{ kind: "heading", text: EMAILS.cancelHeading }, p(EMAILS.cancelSteps(siteUrl)), p(EMAILS.cancelAfter)];
}

function footer(siteUrl: string): EmailDocument["footer"] {
	return {
		links: [
			{ text: EMAILS.footerLinks.plans, href: `${siteUrl}${PLANS_PATH}` },
			{ text: EMAILS.footerLinks.terms, href: `${siteUrl}${TERMS_PATH}` },
		],
		lines: [EMAILS.questions, EMAILS.brand],
	};
}

function message(kind: EmailMessage["kind"], to: string, tenantId: string | undefined, subject: string, doc: EmailDocument): EmailMessage {
	return { kind, from: "billing", to, subject, text: renderEmailText(doc), html: renderEmailHtml(doc), ...(tenantId ? { tenantId } : {}) };
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
	const charge = discountedCents(plan.listCents, input.percentOff);
	const price = priceLine(plan.listCents, charge, input.percentOff, plan.months);
	const blocks: Block[] = [];
	let words: { subject: string; title: string };
	if (input.trialEndsAt) {
		words = EMAILS.trial;
		blocks.push(p(EMAILS.trial.length(TRIAL)), p(EMAILS.trial.charge(formatDay(input.trialEndsAt), charge, plan.name)), p(EMAILS.trial.renews(price)));
	} else {
		words = input.reason === "change" ? EMAILS.changed : EMAILS.paid;
		const rows: { label: string; value: string }[] = [{ label: EMAILS.rows.plan, value: `${plan.name}, ${price}` }];
		if (input.chargedTodayCents !== null) rows.push({ label: EMAILS.rows.chargedToday, value: usd(input.chargedTodayCents) });
		if (input.nextChargeAt) rows.push({ label: EMAILS.rows.nextCharge, value: formatDay(input.nextChargeAt) });
		blocks.push({ kind: "rows", rows }, p(EMAILS.renewsEvery(plan.months)));
	}
	blocks.push(...howToCancel(input.siteUrl));
	const preheader = blocks[0]?.kind === "paragraph" ? blocks[0].text : words.title;
	return message("billing-confirmation", input.to, input.tenantId, words.subject, { title: words.title, preheader, blocks, footer: footer(input.siteUrl) });
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
	const on = formatDay(input.renewsAt);
	const first = EMAILS.renewal.first(on);
	const blocks: Block[] = [p(first), p(EMAILS.renewal.charge(input.amountCents, input.months)), p(EMAILS.renewal.stop), ...howToCancel(input.siteUrl)];
	return message("annual-renewal-notice", input.to, input.tenantId, EMAILS.renewal.subject(on), { title: EMAILS.renewal.title, preheader: first, blocks, footer: footer(input.siteUrl) });
}
