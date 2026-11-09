/**
 * AGPL "Appropriate Legal Notices" (LICENSE section 0, lines 91 to 98, and
 * section 5(d)): every interactive screen shows a copyright notice, that
 * there is no warranty, that people may share the work under the license,
 * and how to view the license. Master decision 2026-11-09 ("make sure we are
 * covered"). See frontdoor/legal-notices.
 */
import React from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, it } from "node:test";
import { parseHTML } from "linkedom";
import { renderToStaticMarkup } from "react-dom/server";

const { COPYRIGHT_NOTICE, LICENSE_LINK_LABEL, LICENSE_NOTICE, LICENSE_PATH } = await import("../frontdoor/legal-notices/index.ts");
const { licenseText } = await import("../frontdoor/legal-notices/license-text.ts");
const { LegalNoticeLine } = await import("../frontdoor/legal-notices/notice.tsx");
const { PublicShell } = await import("../frontdoor/marketing/components/shell.tsx");
const { default: LicensePage } = await import("../frontdoor/app/(public)/legal/license/page.tsx");
const { isAlwaysPublicPath, LEGAL_PATHS, PUBLIC_PAGES } = await import("../frontdoor/marketing/public-paths.ts");
const { SOURCE_REPOSITORY } = await import("../frontdoor/source-link/index.ts");
const { LicenseLink, SourceCodeLink } = await import("../components/sidebar.tsx");

const ROOT = path.join(import.meta.dirname, "..");
const doc = (element: React.ReactElement) => parseHTML(`<html><body>${renderToStaticMarkup(element)}</body></html>`).document;
const text = (element: React.ReactElement) => (doc(element).body.textContent ?? "").replace(/\s+/g, " ");
const hrefs = (element: React.ReactElement) => [...doc(element).querySelectorAll("a")].map((a) => a.getAttribute("href"));

/** The four parts the license's definition asks for. */
function assertAllFourParts(rendered: string, links: (string | null)[]) {
	assert.ok(rendered.includes(COPYRIGHT_NOTICE), "(1) a copyright notice");
	assert.match(rendered, /no warranty/i, "(2) there is no warranty");
	assert.match(rendered, /may copy, change and share it under that license/, "(2) people may convey the work under this License");
	assert.ok(links.includes(LICENSE_PATH), "(2) how to view a copy of this License");
}

describe("AGPL legal notices", () => {
	it("the notice text names the authors, the license, the permission and the lack of warranty", () => {
		assert.match(COPYRIGHT_NOTICE, /Amos Blomqvist/);
		assert.match(COPYRIGHT_NOTICE, /North Aero, Inc\./);
		assert.match(LICENSE_NOTICE, /GNU Affero General Public License, version 3 \(AGPL-3\.0\)/);
		assert.match(LICENSE_NOTICE, /no warranty/);
		assert.equal(LICENSE_PATH, LEGAL_PATHS.license);
		assert.ok(!/—/.test(COPYRIGHT_NOTICE + LICENSE_NOTICE), "no em dashes");
	});

	it("every public page's footer shows all four parts, plus the source link", () => {
		const page = <PublicShell commit="abcdef1">content</PublicShell>;
		assertAllFourParts(text(page), hrefs(page));
		assert.ok(hrefs(page).includes(`${SOURCE_REPOSITORY}/tree/abcdef1`), "source at the deployed commit");
	});

	it("the account and admin screens show the notice line with all four parts", () => {
		const line = <LegalNoticeLine commit="abcdef1" />;
		assertAllFourParts(text(line), hrefs(line));
		assert.ok(hrefs(line).includes(`${SOURCE_REPOSITORY}/tree/abcdef1`));
		for (const layout of ["frontdoor/app/account/layout.tsx", "frontdoor/app/admin/layout.tsx"]) {
			const source = fs.readFileSync(path.join(ROOT, layout), "utf8");
			assert.match(source, /<LegalNoticeLine\b/, `${layout} renders the notice line`);
		}
	});

	it("the tutor's sidebar has a prominent License item beside Source code", () => {
		const link = doc(<LicenseLink />).querySelector("a");
		assert.equal(link?.getAttribute("href"), LICENSE_PATH);
		assert.equal(link?.textContent, LICENSE_LINK_LABEL);
		const sidebar = fs.readFileSync(path.join(ROOT, "components/sidebar.tsx"), "utf8");
		assert.match(sidebar, /<SourceCodeLink \/>\s*<LicenseLink \/>/, "rendered next to Source code");
		assert.ok(SourceCodeLink);
	});

	it("/legal/license shows the notices, the source link and the full, unchanged license text", () => {
		const page = <LicensePage />;
		const rendered = text(page);
		assertAllFourParts(rendered + " ", [...hrefs(page), LICENSE_PATH]);
		assert.ok(hrefs(page).some((h) => h?.startsWith(SOURCE_REPOSITORY)), "source link");
		const pre = doc(page).querySelector("[data-testid=license-text]")?.textContent ?? "";
		assert.equal(pre, fs.readFileSync(path.join(ROOT, "LICENSE"), "utf8"), "the full LICENSE, word for word");
		assert.match(pre, /GNU AFFERO GENERAL PUBLIC LICENSE/);
		assert.match(pre, /13\. Remote Network Interaction/);
	});

	it("/legal/license is public, in the sitemap, and reads the repository's LICENSE", () => {
		assert.ok(isAlwaysPublicPath(LICENSE_PATH));
		assert.ok(PUBLIC_PAGES.includes(LICENSE_PATH));
		const license = fs.readFileSync(path.join(ROOT, "LICENSE"), "utf8");
		assert.equal(licenseText(ROOT), license, "from the repository root (tests)");
		assert.equal(licenseText(path.join(ROOT, "frontdoor")), license, "from frontdoor/ (the front door's build folder)");
	});
});
