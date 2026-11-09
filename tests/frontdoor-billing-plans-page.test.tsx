/**
 * The plans screen (P4-03, P4-04, P4-05; PRD C2 req 1, 3, 4): what each
 * billing status shows, with prices only from plans/index.ts.
 */
import React from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, it } from "node:test";
import { parseHTML } from "linkedom";
import { renderToStaticMarkup } from "react-dom/server";
import { NOTICE_TEXT, PlansView } from "../frontdoor/app/account/plans/plans-view.tsx";
import { SUBSCRIBE_AGAIN_ACTION, trialUsedScreen } from "../frontdoor/billing/copy.ts";
import type { BillingViewOn } from "../frontdoor/billing/view.ts";
import { type Plan, PLANS, TRIAL } from "../frontdoor/plans/index.ts";

const doc = (element: React.ReactElement) => parseHTML(`<html><body>${renderToStaticMarkup(element)}</body></html>`).document;
const text = (element: React.ReactElement) => (doc(element).body.textContent ?? "").replace(/\s+/g, " ");

const base: BillingViewOn = {
	billing: "on",
	status: "none",
	plan: null,
	tester: false,
	discountPercent: null,
	trialEligible: true,
	trialEndsAt: null,
	trialStudyMinutes: null,
	trialStudyLimitMinutes: 120,
	trialUsedUp: null,
	renewsAt: null,
	endsAt: null,
	retentionEndsAt: null,
	canManageBilling: false,
	notice: null,
};
const view = (patch: Partial<BillingViewOn>) => <PlansView view={{ ...base, ...patch }} plans={PLANS} trial={TRIAL} />;
const forms = (element: React.ReactElement) => [...doc(element).querySelectorAll("form")].map((f) => f.getAttribute("action"));

describe("the plans screen", () => {
	it("a new student sees one 'Start 7-day free trial' button on the monthly price", () => {
		const el = view({});
		assert.match(text(el), /Start 7-day free trial/);
		assert.match(text(el), /7 days, with up to 2 hours of study\. A card is required\. After the trial, the Monthly plan is \$69 every month/);
		assert.deepEqual(forms(el), ["/account/billing/checkout"]);
		const plan = doc(el).querySelector('form[action="/account/billing/checkout"] input[name="plan"]');
		assert.equal(plan?.getAttribute("value"), "monthly");
	});

	it("a student with no trial left gets 'Subscribe' on each plan", () => {
		const el = view({ trialEligible: false, notice: "trial-refused-card" });
		assert.deepEqual(forms(el), ["/account/billing/checkout", "/account/billing/checkout", "/account/billing/checkout"]);
		assert.match(text(el), new RegExp(NOTICE_TEXT["trial-refused-card"].replace(/\./g, "\\.")));
	});

	it("during the trial: study minutes used, the end date, and Buy now on each plan with its charge, renewal and a required box", () => {
		const el = view({ status: "trialing", plan: "monthly", trialEligible: false, trialEndsAt: "2026-11-16T15:00:00.000Z", trialStudyMinutes: 34, canManageBilling: true });
		const t = text(el);
		assert.match(t, /34 of 120 minutes of study used\. It ends on November 16, 2026/);
		assert.match(t, /Buy now: \$588 today/);
		assert.match(t, /Charged today: \$179\. Your plan then renews automatically every 3 months at \$179 until you cancel/);
		const boxes = [...doc(el).querySelectorAll('form[action="/account/billing/buy-now"] input[name="agree"]')];
		assert.equal(boxes.length, 3);
		for (const b of boxes) assert.ok(b.hasAttribute("required"));
		assert.ok(forms(el).includes("/account/billing/portal"), "Manage billing");
	});

	it("when the trial is used up: says so, keeps reading, offers Buy now with the student's discount", () => {
		const el = view({ status: "trial-used", plan: "monthly", trialEligible: false, trialUsedUp: "time", discountPercent: 20 });
		const t = text(el);
		assert.match(t, /Your free trial's study time is used up\. Choose a plan below to keep studying\. You can still read all of your chats and records\./);
		assert.match(t, /Buy now: \$470\.40 today/);
		assert.match(t, /\$470\.40 every 12 months \(\$588 less your 20% discount\)/);
		assert.match(text(view({ status: "trial-used", trialUsedUp: "cost" })), /reached its usage limit/);
	});

	it("active, canceling, past due, unpaid and ended each say what happens next", () => {
		// Dates are school time (America/Los_Angeles): 03:00 UTC on November 10 is November 9 in California.
		assert.match(text(view({ status: "active", plan: "annual", renewsAt: "2027-11-10T03:00:00.000Z", canManageBilling: true })), /Your plan: Annual\. It renews on November 9, 2027\./);
		assert.match(text(view({ status: "active", plan: "monthly", tester: true })), /tester, no charge/);
		assert.match(text(view({ status: "canceling", plan: "monthly", endsAt: "2026-12-16T18:00:00.000Z" })), /Your plan ends on December 16, 2026\. You can study until then\./);
		assert.match(text(view({ status: "past-due" })), /did not go through/);
		assert.match(text(view({ status: "unpaid" })), /payments have stopped/);
		const ended = view({ status: "ended", retentionEndsAt: "2027-03-16T18:00:00.000Z", trialEligible: false });
		assert.match(text(ended), /until March 16, 2027/);
		assert.equal(forms(ended).filter((f) => f === "/account/billing/checkout").length, 3);
	});

	it("shows loading, billing off, and every notice", () => {
		assert.match(text(<PlansView view={null} plans={PLANS} trial={TRIAL} />), /Loading your plan/);
		assert.match(text(<PlansView view={{ billing: "off" }} plans={PLANS} trial={TRIAL} />), /Plans are not available yet/);
		for (const [n, words] of Object.entries(NOTICE_TEXT)) assert.ok(text(view({ notice: n as BillingViewOn["notice"] })).includes(words), n);
	});

	it("shows prices from plans/index.ts only", () => {
		const odd: Plan[] = PLANS.map((p) => ({ ...p, priceUsd: p.priceUsd + 1 }));
		const t = text(<PlansView view={{ ...base, status: "trialing", trialEligible: false }} plans={odd} trial={TRIAL} />);
		assert.match(t, /Buy now: \$589 today/);
		assert.equal(t.includes("$588"), false);
		const dir = path.join(import.meta.dirname, "..", "frontdoor", "app", "account", "plans");
		for (const file of fs.readdirSync(dir)) assert.doesNotMatch(fs.readFileSync(path.join(dir, file), "utf8"), /\$\d/, `${file} holds no dollar amount`);
	});

	it("keeps billing's words in one copy file, with no dollar amount and no em dash", () => {
		const copy = fs.readFileSync(path.join(import.meta.dirname, "..", "frontdoor", "billing", "copy.ts"), "utf8");
		assert.doesNotMatch(copy, /\$\d/, "no amount in the copy file: prices come from plans/index.ts");
		assert.equal(copy.includes("—"), false);
		for (const s of Object.values(NOTICE_TEXT)) assert.equal(s.includes("—"), false);
		const screen = trialUsedScreen("/account/read-sessions");
		assert.deepEqual(screen.actions.map((a) => a.href), ["/account/plans", "/account/read-sessions"], "w2-pause's interstitial shape, for the master to wire");
		assert.deepEqual(SUBSCRIBE_AGAIN_ACTION, { label: "Subscribe again", href: "/account/plans" });
	});

	it("the tutor's sidebar links to Account (/account/plans), beside Source code (master, 2026-11-08)", () => {
		const sidebar = fs.readFileSync(path.join(import.meta.dirname, "..", "components", "sidebar.tsx"), "utf8");
		assert.match(sidebar, /<a href="\/account\/plans" data-testid="account-link"[^>]*>Account<\/a>/);
		const changes = fs.readFileSync(path.join(import.meta.dirname, "..", "docs", "upstream-changes.md"), "utf8");
		assert.match(changes, /\| `components\/sidebar\.tsx` \| P4-03 \|/);
	});
});
