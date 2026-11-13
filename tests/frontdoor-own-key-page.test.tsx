/**
 * The student's "Your own AI key" page (master decision, 2026-11-13): what it
 * shows when own keys are off, when no key is saved and when one is, that it
 * shows only the last 4 characters, and the copy rules (plain, no em dash).
 * The page's data and forms are tested end to end in frontdoor-own-key.test.ts.
 */
import React from "react";

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, it } from "node:test";
import { parseHTML } from "linkedom";
import { renderToStaticMarkup } from "react-dom/server";
import { AiKeyView, noticeFrom } from "../frontdoor/app/account/ai-key/ai-key-view.tsx";
import { PlansView } from "../frontdoor/app/account/plans/plans-view.tsx";
import { OWN_KEY_COPY } from "../frontdoor/own-key/copy.ts";
import { PLANS, TRIAL } from "../frontdoor/plans/index.ts";

const TZ = "America/Los_Angeles";
const render = (node: React.ReactElement) => parseHTML(`<!doctype html><html><body>${renderToStaticMarkup(node)}</body></html>`).document;

describe("the own AI key page", () => {
	it("with no key saved: says North Aero's key is in use, and offers a password field that posts to the front door", () => {
		const doc = render(<AiKeyView state={{ enabled: true, saved: null }} notice={null} timeZone={TZ} />);
		const text = doc.body.textContent ?? "";
		assert.match(text, /Your own AI key/);
		assert.match(text, /The tutor uses North Aero's key now\./);
		assert.match(text, /We store your key encrypted\. We show only its last 4 characters\./);
		assert.match(text, /goes to Anthropic under your own account/);
		const form = doc.querySelector("form");
		assert.equal(form?.getAttribute("method"), "post");
		assert.equal(form?.getAttribute("action"), "/_frontdoor/ai-key");
		const input = doc.querySelector("input[name=key]");
		assert.equal(input?.getAttribute("type"), "password");
		assert.match(input?.outerHTML ?? "", /autocomplete="off"/i, "the browser does not keep the key");
		assert.equal(doc.querySelector("input[name=action]")?.getAttribute("value"), "save");
		assert.equal(text.includes(OWN_KEY_COPY.remove), false, "nothing to remove");
	});

	it("with a key saved: shows only its last 4 characters and the date, a Remove button, and a way to replace it", () => {
		const doc = render(<AiKeyView state={{ enabled: true, saved: { last4: "WXYZ", savedAt: new Date("2026-11-13T18:00:00Z") } }} notice={null} timeZone={TZ} />);
		const text = doc.body.textContent ?? "";
		assert.match(text, /The tutor uses your key ending in WXYZ\./);
		assert.match(text, /Saved on Nov 13, 2026\./);
		assert.match(text, /Remove my key/);
		assert.match(text, /Use a different key/);
		const actions = [...doc.querySelectorAll("input[name=action]")].map((i) => i.getAttribute("value"));
		assert.deepEqual(actions, ["remove", "save"]);
		assert.equal(doc.body.innerHTML.includes("sk-ant-api03-"), false);
	});

	it("when own keys are off: says so plainly, offers no save, and still lets a saved key be removed", () => {
		const off = render(<AiKeyView state={{ enabled: false, saved: null }} notice={null} timeZone={TZ} />);
		assert.match(off.body.textContent ?? "", /Own AI keys are turned off right now\. The tutor uses North Aero's key\./);
		assert.equal(off.querySelector("input[name=key]"), null);
		const offSaved = render(<AiKeyView state={{ enabled: false, saved: { last4: "WXYZ", savedAt: new Date() } }} notice={null} timeZone={TZ} />);
		assert.match(offSaved.body.textContent ?? "", /ending in WXYZ is saved, but it is not in use/);
		assert.deepEqual([...offSaved.querySelectorAll("input[name=action]")].map((i) => i.getAttribute("value")), ["remove"]);
		const down = render(<AiKeyView state="unavailable" notice={null} timeZone={TZ} />);
		assert.match(down.body.textContent ?? "", /not available right now/);
		assert.equal(down.querySelector("form"), null);
	});

	it("shows the result of a save or a removal, and ignores an unknown value in the address", () => {
		assert.deepEqual(noticeFrom({ saved: "1" }), { kind: "done", text: OWN_KEY_COPY.done.saved });
		assert.deepEqual(noticeFrom({ removed: "1" }), { kind: "done", text: OWN_KEY_COPY.done.removed });
		for (const problem of Object.keys(OWN_KEY_COPY.problems) as Array<keyof typeof OWN_KEY_COPY.problems>) {
			assert.deepEqual(noticeFrom({ error: problem }), { kind: "problem", text: OWN_KEY_COPY.problems[problem] });
		}
		assert.equal(noticeFrom({ error: "<script>" }), null);
		assert.equal(noticeFrom({ error: "toString" }), null);
		assert.equal(noticeFrom({}), null);
		const doc = render(<AiKeyView state={{ enabled: true, saved: null }} notice={noticeFrom({ error: "refused" })} timeZone={TZ} />);
		assert.equal(doc.querySelector("[role=alert]")?.textContent, OWN_KEY_COPY.problems.refused);
	});

	it("keeps its words in one copy file: plain sentences, no em dash, no dollar amount", () => {
		const copy = fs.readFileSync(path.join(import.meta.dirname, "..", "frontdoor", "own-key", "copy.ts"), "utf8");
		assert.equal(copy.includes("—"), false);
		assert.doesNotMatch(copy, /\$\d/);
		for (const file of ["page.tsx", "ai-key-view.tsx"]) {
			const source = fs.readFileSync(path.join(import.meta.dirname, "..", "frontdoor", "app", "account", "ai-key", file), "utf8");
			assert.equal(source.includes("—"), false, file);
		}
	});

	it("the plans screen, where the tutor's Account link lands, links to it", () => {
		const doc = render(<PlansView view={null} plans={PLANS} trial={TRIAL} />);
		const link = [...doc.querySelectorAll("a")].find((a) => a.getAttribute("href") === "/account/ai-key");
		assert.equal(link?.textContent, "Your own AI key");
	});
});
