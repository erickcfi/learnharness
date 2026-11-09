/**
 * Reduced motion on the public pages (W2-11).
 *
 * A visitor who asks for reduced motion sees still frames: no screen is
 * armed or played, the tour never moves on by itself, and the stylesheet
 * animates nothing outside `prefers-reduced-motion: no-preference`. The
 * server and a browser without JavaScript also get still frames.
 */
import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, describe, it, mock } from "node:test";
import { parseHTML } from "linkedom";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { PlayOnView } from "../frontdoor/marketing/components/play-on-view.tsx";
import { SCREEN_DURATION_MS, TutorScreen } from "../frontdoor/marketing/components/screens.tsx";
import { Tour } from "../frontdoor/marketing/components/tour.tsx";
import { TOUR_TABS, type ScreenId } from "../frontdoor/marketing/copy.ts";
import { motionAllowed, REDUCED_MOTION_QUERY } from "../frontdoor/marketing/motion.ts";

const CSS = fs.readFileSync(path.join(import.meta.dirname, "..", "frontdoor", "marketing", "marketing.css"), "utf8");
const SCREEN_IDS: ScreenId[] = ["ask", "probe", "plan", "teach", "practice", "record"];

const dom = parseHTML("<html><body></body></html>");
const win = dom.window as unknown as Record<string, unknown>;
Object.assign(globalThis, { window: dom.window, document: dom.document });

function prefersReducedMotion(reduce: boolean) {
	win.matchMedia = (query: string) => ({ matches: query === REDUCED_MOTION_QUERY ? reduce : false, media: query });
}

const mounted: { root: Root; host: HTMLElement }[] = [];
async function mount(element: React.ReactElement): Promise<HTMLElement> {
	const host = dom.document.createElement("div");
	dom.document.body.appendChild(host);
	const root = createRoot(host);
	await act(async () => root.render(element));
	mounted.push({ root, host });
	return host;
}

afterEach(async () => {
	for (const { root, host } of mounted.splice(0)) {
		await act(async () => root.unmount());
		host.remove();
	}
	mock.timers.reset();
	delete win.matchMedia;
});

/** CSS with every `@media (prefers-reduced-motion: no-preference) { ... }` block cut out. */
function cssOutsideNoPreference(css: string): string {
	let out = "";
	let i = 0;
	const marker = "@media (prefers-reduced-motion: no-preference)";
	while (i < css.length) {
		const start = css.indexOf(marker, i);
		if (start === -1) {
			out += css.slice(i);
			break;
		}
		out += css.slice(i, start);
		let depth = 0;
		let j = css.indexOf("{", start);
		for (; j < css.length; j++) {
			if (css[j] === "{") depth++;
			else if (css[j] === "}" && --depth === 0) break;
		}
		i = j + 1;
	}
	return out;
}

describe("motionAllowed", () => {
	it("is false when the visitor asks for reduced motion", () => {
		assert.equal(motionAllowed({ matchMedia: (q) => ({ matches: q === REDUCED_MOTION_QUERY }) }), false);
	});

	it("is true when they do not", () => {
		assert.equal(motionAllowed({ matchMedia: () => ({ matches: false }) }), true);
	});

	it("is false when the browser cannot tell", () => {
		assert.equal(motionAllowed({}), false);
		assert.equal(
			motionAllowed({
				matchMedia: () => {
					throw new Error("no");
				},
			}),
			false,
		);
	});
});

describe("the stylesheet", () => {
	it("animates only inside prefers-reduced-motion: no-preference", () => {
		const outside = cssOutsideNoPreference(CSS);
		const declarations = [...outside.matchAll(/animation(?:-name)?\s*:\s*([^;]+);/g)].map((m) => m[1]!.trim());
		assert.deepEqual(
			declarations.filter((value) => !/^none( !important)?$/.test(value)),
			[],
		);
		assert.ok(CSS.includes("@media (prefers-reduced-motion: no-preference)"));
	});

	it("turns every animation off for reduced motion", () => {
		const block = /@media \(prefers-reduced-motion: reduce\)\s*\{([\s\S]*?)\n\}/.exec(CSS)?.[1] ?? "";
		assert.match(block, /\.na-site \*/);
		assert.match(block, /animation:\s*none !important/);
		assert.match(block, /transition:\s*none !important/);
	});

	it("animates only screens that a script armed or played", () => {
		const inside = CSS.slice(CSS.indexOf("@media (prefers-reduced-motion: no-preference)"));
		for (const m of inside.matchAll(/^\t(\.[^{]+)\{/gm)) {
			const selector = m[1]!;
			if (selector.includes(".na-fx")) assert.match(selector, /\.na-motion(:not\(\[data-motion="still"\]\)|\[data-motion="(armed|playing)"\])/, selector);
		}
	});
});

describe("still frames without JavaScript", () => {
	it("the server sends every screen still", () => {
		for (const id of SCREEN_IDS) {
			const html = renderToStaticMarkup(
				<PlayOnView replayLabel="Replay">
					<TutorScreen id={id} />
				</PlayOnView>,
			);
			assert.match(html, /data-motion="still"/, id);
			assert.equal(html.includes("Replay"), false, `${id}: no Replay button without motion`);
		}
		const tour = renderToStaticMarkup(<Tour />);
		assert.match(tour, /data-motion="still"/);
		assert.match(tour, /data-auto="off"/);
	});

	it("each screen's final frame is complete: its text is in the page", () => {
		const html = renderToStaticMarkup(<TutorScreen id="probe" />);
		const shown = (parseHTML(`<html><body>${html}</body></html>`).document.body.textContent ?? "").replace(/\s+/g, " ");
		assert.ok(shown.includes("Pretty sure it's Zulu. Same as on my flight plan."));
		assert.ok(html.includes("is-picked"));
	});
});

describe("in a browser that asks for reduced motion", () => {
	it("PlayOnView keeps the still frame", async () => {
		prefersReducedMotion(true);
		const host = await mount(
			<PlayOnView replayLabel="Replay">
				<TutorScreen id="teach" />
			</PlayOnView>,
		);
		assert.equal(host.querySelector(".na-motion")?.getAttribute("data-motion"), "still");
		assert.equal(host.querySelector(".na-replay"), null);
	});

	it("the tour shows still frames and never moves on by itself", async () => {
		mock.timers.enable({ apis: ["setTimeout"] });
		prefersReducedMotion(true);
		const host = await mount(<Tour />);
		assert.equal(host.querySelector(".na-tour-step.is-on .na-motion")?.getAttribute("data-motion"), "still");
		await act(async () => mock.timers.tick(Math.max(...Object.values(SCREEN_DURATION_MS)) * 3));
		assert.equal(host.querySelector('[aria-selected="true"]')?.textContent, `1${TOUR_TABS[0].tab}`);
		assert.equal(host.querySelector(".na-tour-pause"), null);
		const states = [...host.querySelectorAll(".na-motion")].map((el) => el.getAttribute("data-motion"));
		assert.deepEqual(states, TOUR_TABS.map(() => "still"));
		assert.match(host.querySelector(".na-tour")?.getAttribute("data-auto") ?? "", /^off$/);
	});

	it("the tour's step buttons still work", async () => {
		prefersReducedMotion(true);
		const host = await mount(<Tour />);
		const third = host.querySelectorAll<HTMLButtonElement>('[role="tab"]')[2]!;
		await act(async () => third.click());
		assert.equal(host.querySelector('[aria-selected="true"]')?.textContent, `3${TOUR_TABS[2].tab}`);
		assert.equal(host.querySelector(".na-tour-step.is-on .na-motion")?.getAttribute("data-motion"), "still");
	});
});

describe("in a browser that allows motion", () => {
	it("PlayOnView plays the screen and offers Replay", async () => {
		prefersReducedMotion(false);
		const host = await mount(
			<PlayOnView replayLabel="Replay">
				<TutorScreen id="teach" />
			</PlayOnView>,
		);
		assert.equal(host.querySelector(".na-motion")?.getAttribute("data-motion"), "playing");
		assert.ok(host.querySelector(".na-replay"));
	});

	it("the tour moves on by itself, and stops when the visitor picks a step", async () => {
		mock.timers.enable({ apis: ["setTimeout"] });
		prefersReducedMotion(false);
		const host = await mount(<Tour />);
		assert.equal(host.querySelector(".na-tour-step.is-on .na-motion")?.getAttribute("data-motion"), "playing");
		await act(async () => mock.timers.tick(SCREEN_DURATION_MS[TOUR_TABS[0].id]));
		assert.equal(host.querySelector('[aria-selected="true"]')?.textContent?.startsWith("2"), true);
		const first = host.querySelectorAll<HTMLButtonElement>('[role="tab"]')[0]!;
		await act(async () => first.click());
		await act(async () => mock.timers.tick(Math.max(...Object.values(SCREEN_DURATION_MS)) * 3));
		assert.equal(host.querySelector('[aria-selected="true"]')?.textContent?.startsWith("1"), true);
	});

	it("the tour has a Pause button", async () => {
		mock.timers.enable({ apis: ["setTimeout"] });
		prefersReducedMotion(false);
		const host = await mount(<Tour />);
		const pause = host.querySelector<HTMLButtonElement>(".na-tour-pause")!;
		assert.ok(pause);
		await act(async () => pause.click());
		await act(async () => mock.timers.tick(Math.max(...Object.values(SCREEN_DURATION_MS)) * 3));
		assert.equal(host.querySelector('[aria-selected="true"]')?.textContent?.startsWith("1"), true);
	});
});
