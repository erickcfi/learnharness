/**
 * The public pages' content (W2-11): landing page, How it works, Help,
 * legal placeholders, footer, and the search files.
 *
 * Prices on the pages come from frontdoor/plans only: a page rendered with
 * other plan values shows those values, and no page or copy file holds a
 * dollar amount of its own.
 */
import React from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, it } from "node:test";
import { parseHTML } from "linkedom";
import { renderToStaticMarkup } from "react-dom/server";
import Help, { metadata as helpMetadata } from "../frontdoor/app/(public)/help/page.tsx";
import HowItWorks from "../frontdoor/app/(public)/how-it-works/page.tsx";
import AiNotice from "../frontdoor/app/(public)/legal/ai-notice/page.tsx";
import Privacy from "../frontdoor/app/(public)/legal/privacy/page.tsx";
import Terms from "../frontdoor/app/(public)/legal/terms/page.tsx";
import Landing, { metadata as landingMetadata } from "../frontdoor/app/(public)/page.tsx";
import robots from "../frontdoor/app/robots.ts";
import sitemap from "../frontdoor/app/sitemap.ts";
import { HelpPage, HowItWorksPage, LandingPage } from "../frontdoor/marketing/components/pages.tsx";
import { PublicShell } from "../frontdoor/marketing/components/shell.tsx";
import { CTA, HELP, HOW_IT_WORKS, LANDING, LEGAL, NAV, TOUR_TABS } from "../frontdoor/marketing/copy.ts";
import { LEGAL_PATHS, OG_IMAGE_PATH, PUBLIC_PAGES, SIGN_IN_PATH, SIGN_UP_PATH } from "../frontdoor/marketing/public-paths.ts";
import { SITE_ORIGIN } from "../frontdoor/marketing/site.ts";
import { formatUsd, PLANS, TRIAL, type Plan, type Trial } from "../frontdoor/plans/index.ts";
import { SOURCE_LINK_LABEL, SOURCE_REPOSITORY, sourceUrl } from "../frontdoor/source-link/index.ts";

const FRONTDOOR = path.join(import.meta.dirname, "..", "frontdoor");

const doc = (element: React.ReactElement) => parseHTML(`<html><body>${renderToStaticMarkup(element)}</body></html>`).document;
const text = (element: React.ReactElement) => (doc(element).body.textContent ?? "").replace(/\s+/g, " ");

const ODD_PLANS: Plan[] = [
	{ id: "monthly", name: "Monthly", priceUsd: 71, months: 1 },
	{ id: "quarterly", name: "3 months", priceUsd: 183, months: 3 },
	{ id: "annual", name: "Annual", priceUsd: 590, months: 12 },
];
const ODD_TRIAL: Trial = { days: 5, studyHours: 3, cardRequired: true, convertsTo: "monthly" };

/** Every source file of the public pages, for the text rules below. */
function publicSourceFiles(): string[] {
	const files: string[] = [];
	const walk = (dir: string) => {
		for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) walk(full);
			else if (/\.(ts|tsx|css)$/.test(entry.name)) files.push(full);
		}
	};
	walk(path.join(FRONTDOOR, "marketing"));
	walk(path.join(FRONTDOOR, "app", "(public)"));
	files.push(path.join(FRONTDOOR, "app", "robots.ts"), path.join(FRONTDOOR, "app", "sitemap.ts"), path.join(FRONTDOOR, "app", "account", "brand", "og", "route.tsx"));
	return files;
}

describe("landing page", () => {
	it("says what the tutor is, who it is for, and that it is 18+", () => {
		const t = text(<Landing />);
		for (const line of [...LANDING.hero.titleLines, LANDING.hero.lead, LANDING.audience.title, LANDING.audience.age, LANDING.honest.title]) {
			assert.ok(t.includes(line), line);
		}
		assert.match(t, /FAA, NTSB and POH/);
		assert.match(t, /Answers come from AI and can be wrong/);
	});

	it("leads every 'Start your free trial' button to the sign-up flow", () => {
		const page = doc(
			<PublicShell commit={null} year={2026}>
				<Landing />
			</PublicShell>,
		);
		const ctas = [...page.querySelectorAll('[data-cta="start-trial"]')];
		assert.ok(ctas.length >= 3, `found ${ctas.length} trial buttons`);
		for (const a of ctas) assert.equal(a.getAttribute("href"), SIGN_UP_PATH);
		const labels = ctas.map((a) => a.textContent);
		assert.ok(labels.includes(CTA.startTrial));
		assert.ok(labels.includes(NAV.startTrial));
		assert.ok([...page.querySelectorAll("a")].some((a) => a.getAttribute("href") === SIGN_IN_PATH && a.textContent === NAV.signIn));
		assert.equal(SIGN_UP_PATH, "/account/sign-up");
	});

	it("shows the prices and the trial from the plans config", () => {
		const t = text(<Landing />);
		for (const plan of PLANS) assert.ok(t.includes(formatUsd(plan.priceUsd)), plan.id);
		assert.ok(t.includes(`free ${TRIAL.days}-day trial`));
		assert.ok(t.includes(`up to ${TRIAL.studyHours} hours of study`));
	});

	it("shows other prices when the config changes, and none of the old ones", () => {
		const t = text(<LandingPage plans={ODD_PLANS} trial={ODD_TRIAL} />);
		for (const price of ["$71", "$183", "$590"]) assert.ok(t.includes(price), price);
		for (const old of PLANS) assert.equal(t.includes(formatUsd(old.priceUsd)), false, `${formatUsd(old.priceUsd)} still shown`);
		assert.ok(t.includes("free 5-day trial"));
		assert.ok(t.includes("up to 3 hours of study"));
		assert.ok(t.includes("About $61 a month"), "3 months at $183 is about $61 a month");
	});

	it("has the short tour, with its five steps", () => {
		const page = doc(<Landing />);
		const tabs = [...page.querySelectorAll('[role="tab"]')].map((tab) => tab.textContent);
		assert.deepEqual(
			tabs,
			TOUR_TABS.map((tab, i) => `${i + 1}${tab.tab}`),
		);
	});
});

describe("other public pages", () => {
	it("How it works walks through every step, each with its screen", () => {
		const page = doc(<HowItWorks />);
		const steps = [...page.querySelectorAll("[data-step]")];
		assert.deepEqual(
			steps.map((s) => s.getAttribute("data-step")),
			HOW_IT_WORKS.steps.map((s) => s.id),
		);
		for (const step of steps) assert.ok(step.querySelector(".na-ts"), `${step.getAttribute("data-step")} has a screen`);
		const t = text(<HowItWorks />);
		for (const step of HOW_IT_WORKS.steps) assert.ok(t.includes(step.title), step.title);
		assert.ok(t.includes("Not a logbook entry or instructor endorsement."), "the record label (N8)");
	});

	it("Help covers the brief's topics and the FAQ", () => {
		const t = text(<Help />);
		for (const section of HELP.sections) assert.ok(t.includes(section.title), section.title);
		for (const topic of ["Start a session", "Answer the tutor", "Use practice", "Import your own notes", "Print or email your record", "Cancel"]) {
			assert.ok(t.includes(topic), topic);
		}
		for (const item of HELP.faq(PLANS, TRIAL)) assert.ok(t.includes(item.q), item.q);
		assert.ok(t.includes("info@flynorthaero.com"));
	});

	it("Help and How it works also read prices from the config", () => {
		const help = text(<HelpPage plans={ODD_PLANS} trial={ODD_TRIAL} />);
		const how = text(<HowItWorksPage plans={ODD_PLANS} trial={ODD_TRIAL} />);
		for (const price of ["$71", "$183", "$590"]) assert.ok(help.includes(price), price);
		assert.ok(how.includes("$71"));
		for (const old of PLANS) {
			assert.equal(help.includes(formatUsd(old.priceUsd)), false);
			assert.equal(how.includes(formatUsd(old.priceUsd)), false);
		}
	});

	it("the legal pages say Coming soon", () => {
		for (const [Page, title] of [
			[Terms, LEGAL.terms.title],
			[Privacy, LEGAL.privacy.title],
			[AiNotice, LEGAL.aiNotice.title],
		] as const) {
			const t = text(<Page />);
			assert.ok(t.includes(title), title);
			assert.ok(t.includes("Coming soon."), title);
		}
	});
});

describe("footer on every public page", () => {
	it("links to the source at the deployed commit, and to the legal pages", () => {
		const page = doc(
			<PublicShell commit="AbCdEf1234567" year={2026}>
				<p>x</p>
			</PublicShell>,
		);
		const links = [...page.querySelectorAll("footer a")].map((a) => [a.textContent, a.getAttribute("href")]);
		assert.ok(links.some(([label, href]) => label === SOURCE_LINK_LABEL && href === sourceUrl("AbCdEf1234567")));
		assert.ok(links.some(([, href]) => href === `${SOURCE_REPOSITORY}/tree/abcdef1234567`));
		for (const href of [LEGAL_PATHS.terms, LEGAL_PATHS.privacy, LEGAL_PATHS.aiNotice]) assert.ok(links.some(([, h]) => h === href), href);
	});

	it("falls back to the repository home without a commit", () => {
		const page = doc(
			<PublicShell commit={undefined} year={2026}>
				<p>x</p>
			</PublicShell>,
		);
		assert.ok([...page.querySelectorAll("footer a")].some((a) => a.getAttribute("href") === SOURCE_REPOSITORY));
	});

	it("is in the layout that wraps every public page", () => {
		const layout = fs.readFileSync(path.join(FRONTDOOR, "app", "(public)", "layout.tsx"), "utf8");
		assert.match(layout, /<PublicShell commit=\{process\.env\.RAILWAY_GIT_COMMIT_SHA\}>/);
		const pages: string[] = [];
		const walk = (dir: string) => {
			for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
				if (entry.isDirectory()) walk(path.join(dir, entry.name));
				else if (entry.name === "page.tsx") pages.push(path.relative(path.join(FRONTDOOR, "app", "(public)"), dir).split(path.sep).join("/"));
			}
		};
		walk(path.join(FRONTDOOR, "app", "(public)"));
		assert.deepEqual(pages.map((p) => (p === "" ? "/" : `/${p}`)).sort(), [...PUBLIC_PAGES].sort());
	});
});

describe("no Clerk or other third-party scripts on public pages", () => {
	it("keeps Clerk out of the root and public layouts", () => {
		for (const file of [path.join(FRONTDOOR, "app", "layout.tsx"), ...publicSourceFiles()]) {
			assert.equal(/@clerk\//.test(fs.readFileSync(file, "utf8")), false, path.relative(FRONTDOOR, file));
		}
		assert.match(fs.readFileSync(path.join(FRONTDOOR, "app", "account", "layout.tsx"), "utf8"), /ClerkProvider/);
	});

	it("runs Clerk's middleware on /account pages only", () => {
		// Read, not imported: importing proxy.ts would load Clerk's server code.
		const source = fs.readFileSync(path.join(FRONTDOOR, "proxy.ts"), "utf8");
		const patterns = [...source.matchAll(/^\s*"(\/[^"]*)",?$/gm)].map((m) => m[1]!.replace(/\\\\/g, "\\"));
		assert.equal(patterns.length, 1, "one matcher pattern");
		const matcher = new RegExp(`^${patterns[0]}$`);
		for (const p of ["/account/sign-in", "/account/sign-up/verify", "/account/confirm-age", "/account/sign-out"]) assert.ok(matcher.test(p), p);
		for (const p of ["/", "/how-it-works", "/help", "/legal/terms", "/robots.txt", "/sitemap.xml", "/account/brand/og", "/account/brand/icon.svg", "/account/_next/static/x.js"]) {
			assert.equal(matcher.test(p), false, p);
		}
	});

	it("renders no script tags of its own", () => {
		const html = renderToStaticMarkup(
			<PublicShell commit={null} year={2026}>
				<Landing />
			</PublicShell>,
		);
		assert.equal(/<script/i.test(html), false);
		assert.equal(/https?:\/\/(?!github\.com\/erickcfi\/learnharness)[^"]*\.(js|css)/.test(html), false);
	});
});

describe("public page HTML loads no Clerk script", () => {
	/** Every package a file imports, following relative imports through the front door's own files. */
	function packagesReachedFrom(entries: string[]): Set<string> {
		const seen = new Set<string>();
		const packages = new Set<string>();
		const resolve = (from: string, spec: string) => {
			const base = path.resolve(path.dirname(from), spec);
			for (const candidate of [base, `${base}.ts`, `${base}.tsx`, path.join(base, "index.ts")]) {
				if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
			}
			throw new Error(`cannot resolve ${spec} from ${from}`);
		};
		const walk = (file: string) => {
			if (seen.has(file)) return;
			seen.add(file);
			if (file.endsWith(".css")) return;
			const source = fs.readFileSync(file, "utf8");
			// Import and export statements only (at the start of a line), and import("...").
			for (const m of source.matchAll(/^\s*(?:import|export)\s[^;]*?\bfrom\s*["']([^"']+)["']|^\s*import\s*["']([^"']+)["']|\bimport\(\s*["']([^"']+)["']\s*\)/gm)) {
				const spec = (m[1] ?? m[2] ?? m[3])!;
				if (spec.startsWith(".")) walk(resolve(file, spec));
				else packages.add(spec);
			}
		};
		for (const entry of entries) walk(entry);
		return packages;
	}

	it("no Clerk code can reach the public pages' bundles", () => {
		const entries = [path.join(FRONTDOOR, "app", "layout.tsx"), path.join(FRONTDOOR, "app", "robots.ts"), path.join(FRONTDOOR, "app", "sitemap.ts")];
		const walk = (dir: string) => {
			for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
				const full = path.join(dir, entry.name);
				if (entry.isDirectory()) walk(full);
				else if (/^(page|layout)\.tsx$/.test(entry.name)) entries.push(full);
			}
		};
		walk(path.join(FRONTDOOR, "app", "(public)"));
		const packages = [...packagesReachedFrom(entries)].sort();
		assert.equal(
			packages.some((p) => p.startsWith("@clerk/")),
			false,
			packages.join(", "),
		);
		assert.deepEqual(packages, ["next", "next/font/google", "react"]);
	});

	const BUILT = path.join(FRONTDOOR, ".next", "server", "app");
	const built = fs.existsSync(path.join(BUILT, "index.html"));
	it("the built public pages, and every script they load, hold no Clerk code", { skip: !built && "the front door is not built (npm run build -w frontdoor)" }, () => {
		for (const page of ["index.html", "how-it-works.html", "help.html", "legal/terms.html", "legal/privacy.html", "legal/ai-notice.html"]) {
			const html = fs.readFileSync(path.join(BUILT, page), "utf8");
			assert.equal(/clerk/i.test(html), false, page);
			const scripts = [...html.matchAll(/<script[^>]*\ssrc="([^"]+)"/g)].map((m) => m[1]!);
			assert.ok(scripts.length > 0, `${page} loads its scripts`);
			for (const src of scripts) {
				assert.match(src, /^\/account\/_next\/static\//, `${page}: ${src} is first-party`);
				const code = fs.readFileSync(path.join(FRONTDOOR, ".next", src.replace(/^\/account\/_next\//, "")), "utf8");
				assert.equal(/clerk/i.test(code), false, `${page}: ${src}`);
			}
		}
	});
});

describe("text rules for Erick's copy", () => {
	it("no page or copy file holds a dollar amount of its own", () => {
		const offenders = publicSourceFiles().filter((file) => /\$\s?\d/.test(fs.readFileSync(file, "utf8")));
		assert.deepEqual(
			offenders.map((f) => path.relative(FRONTDOOR, f)),
			[],
		);
	});

	it("has no em dashes", () => {
		const offenders = publicSourceFiles().filter((file) => fs.readFileSync(file, "utf8").includes("—"));
		assert.deepEqual(
			offenders.map((f) => path.relative(FRONTDOOR, f)),
			[],
		);
	});

	it("makes no pass-rate or FAA-approval claims", () => {
		const copy = fs.readFileSync(path.join(FRONTDOOR, "marketing", "copy.ts"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
		assert.equal(/pass rate|guarantee|testimonial/i.test(copy), false);
		// "FAA-approved" may appear only when denied: after "not ", or as an item in the "It isn't" list.
		for (const match of copy.matchAll(/FAA[- ]approved/gi)) {
			const before = copy.slice(Math.max(0, match.index - 4), match.index);
			const lineSoFar = copy.slice(copy.lastIndexOf("\n", match.index) + 1, match.index);
			assert.ok(before.toLowerCase() === "not " || /^\s*"$/.test(lineSoFar), `claim at ${match.index}: ${copy.slice(match.index - 30, match.index + 30)}`);
		}
		assert.ok(LANDING.honest.isnt.some((line) => line.startsWith("FAA-approved training. It does not")));
	});
});

describe("search basics", () => {
	it("each page has a title, a description, a canonical link and the share image", () => {
		for (const metadata of [landingMetadata, helpMetadata]) {
			assert.ok(metadata.title);
			assert.ok(typeof metadata.description === "string" && metadata.description.length > 40);
			assert.ok(metadata.alternates?.canonical);
			const images = metadata.openGraph?.images;
			assert.ok(Array.isArray(images) && images.some((image) => typeof image === "object" && "url" in image && image.url === OG_IMAGE_PATH));
			assert.equal(String(metadata.metadataBase), `${SITE_ORIGIN}/`);
		}
		assert.match(String(landingMetadata.description), new RegExp(`${TRIAL.days} days`));
	});

	it("robots.txt opens the public pages and the share image, and closes the rest", () => {
		const rules = robots().rules;
		const rule = Array.isArray(rules) ? rules[0] : rules;
		assert.deepEqual(rule?.allow, ["/", "/account/brand/"]);
		assert.deepEqual(rule?.disallow, ["/api/", "/account/", "/chat/", "/settings"]);
		assert.equal(robots().sitemap, `${SITE_ORIGIN}/sitemap.xml`);
	});

	it("the sitemap lists the public pages only", () => {
		assert.deepEqual(
			sitemap().map((entry) => entry.url),
			PUBLIC_PAGES.map((p) => `${SITE_ORIGIN}${p}`),
		);
	});
});
