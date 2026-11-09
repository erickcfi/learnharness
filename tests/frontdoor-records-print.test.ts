/**
 * North Aero study record print view (P6-01, C6 req 1 and 2, N8).
 *
 * C6 acceptance test: "The print view renders with the label on every
 * page." The label is "Self-study record. Not a logbook entry or
 * instructor endorsement." Owner ruling 2026-11-08: it prints at the top
 * and the bottom of every page.
 *
 * Two layers:
 *   1. Structure (always runs): the label sits in the page table's
 *      <thead> and <tfoot>, which the print CSS repeats on every page.
 *   2. Real render: Chrome prints a multi-page record to PDF, and pdf.js
 *      reads each page back. Every page must carry the label twice.
 *      Runs in CI (GitHub's Linux runner has Chrome). Skips, with the
 *      reason, where no Chrome is found (set CHROME_PATH to run it).
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
	RECORD_LABEL,
	buildStudyRecord,
	renderStudyRecordHtml,
	type RecordSource,
	type UpstreamChatRecord,
	type UpstreamChatSummary,
	type UpstreamGraph,
	type UpstreamMessage,
} from "../frontdoor/records/index.ts";
import { findChrome } from "./helpers/frontdoor-records-chrome.ts";

const TOPICS = ["Station identifier", "Date and time", "Wind group", "Visibility", "Present weather", "Sky condition", "Temperature and dew point", "Altimeter", "Remarks"];

/** A record long enough to run several printed pages. */
function bigSource(sessions: number, factsPerSession: number): RecordSource {
	const chats: UpstreamChatSummary[] = [];
	const records: Record<string, UpstreamChatRecord> = {};
	const propositions: UpstreamGraph["propositions"] = [];
	for (let i = 0; i < sessions; i++) {
		const id = `chat_${String(i).padStart(3, "0")}`;
		const day = new Date(Date.UTC(2026, 8, 1 + i, 17)).toISOString();
		const title = `Session ${i + 1}: METAR and TAF practice`;
		chats.push({ id, title, createdAt: day, updatedAt: day, kind: i % 5 === 4 ? "practice" : "teach", messageCount: 3, phase: "teach" });
		const nodes = TOPICS.map((t, k) => ({ id: `t${k}`, title: t }));
		const messages: UpstreamMessage[] = [{ role: "user", content: "go", timestamp: 1 }];
		for (let k = 0; k <= i % TOPICS.length; k++) {
			messages.push({ role: "assistant", content: [{ type: "toolCall", id: `q${k}`, name: "quiz", arguments: { nodeId: `t${k}` } }], timestamp: 2 });
		}
		records[id] = {
			id,
			title,
			createdAt: day,
			updatedAt: day,
			kind: chats[i]!.kind,
			tree: { nodes, edges: [], version: 1 },
			messages,
		};
		for (let f = 0; f < factsPerSession; f++) {
			propositions.push({
				id: `n_${i}_${f}`,
				name: `Fact ${i + 1}.${f + 1}`,
				statement: "A METAR reports the surface observation at one station, including wind, visibility, weather, sky condition, temperature, dew point, and altimeter setting.",
				createdAt: day,
				provenance: [{ chatId: id }],
			});
		}
	}
	return { chats, records, graph: { propositions, sessions: Object.fromEntries(chats.map((c) => [c.id, c.title])), fileSources: {} } };
}

const OPTS = { studentName: "Pat Lee", printedAt: new Date("2026-11-08T18:00:00Z"), timeZone: "America/Los_Angeles" };

function count(haystack: string, needle: string): number {
	let n = 0;
	for (let at = haystack.indexOf(needle); at !== -1; at = haystack.indexOf(needle, at + needle.length)) n++;
	return n;
}

describe("study record HTML: structure", () => {
	const html = renderStudyRecordHtml(buildStudyRecord(bigSource(3, 2), OPTS));

	it("is a whole HTML document with a title", () => {
		assert.ok(html.startsWith("<!doctype html>"));
		assert.match(html, /<title>Study record: Pat Lee<\/title>/);
	});

	it("puts the label in the page table's repeating header and footer", () => {
		const thead = /<thead>([\s\S]*?)<\/thead>/.exec(html)?.[1] ?? "";
		const tfoot = /<tfoot>([\s\S]*?)<\/tfoot>/.exec(html)?.[1] ?? "";
		assert.ok(thead.includes(RECORD_LABEL), "label in <thead>");
		assert.ok(tfoot.includes(RECORD_LABEL), "label in <tfoot>");
		assert.match(html, /thead\s*\{[^}]*display:\s*table-header-group/);
		assert.match(html, /tfoot\s*\{[^}]*display:\s*table-footer-group/);
		assert.match(html, /@page\s*\{/);
	});

	it("shows the header facts: name, print date, range, totals", () => {
		assert.ok(html.includes("Pat Lee"));
		assert.ok(html.includes("Nov 8, 2026"), "print date");
		assert.ok(html.includes("Sep 1, 2026") && html.includes("Sep 3, 2026"), "date range");
		assert.ok(html.includes("America/Los_Angeles"), "time zone named");
	});

	it("shows a dash for study time the front door has not recorded", () => {
		assert.ok(/<td class="length">–<\/td>/.test(html), "length cell shows the dash");
	});

	it("escapes every upstream string", () => {
		const src = bigSource(1, 1);
		const evil = `<script>alert("x")</script> & 'quotes'`;
		src.chats[0]!.title = evil;
		src.records[src.chats[0]!.id]!.title = evil;
		src.graph.propositions[0]!.name = evil;
		src.graph.propositions[0]!.statement = evil;
		const out = renderStudyRecordHtml(buildStudyRecord(src, { ...OPTS, studentName: evil }));
		assert.ok(!out.includes("<script>"), "no raw script tag");
		assert.ok(out.includes("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; &#39;quotes&#39;"));
	});
});

const chrome = findChrome();

describe("study record print view (real Chrome render)", () => {
	it(
		"the print view renders with the label on every page",
		{ skip: chrome === null && "no Chrome or Chromium found; set CHROME_PATH to run this test", timeout: 120_000 },
		async (t) => {
			const html = renderStudyRecordHtml(buildStudyRecord(bigSource(40, 4), OPTS));
			const puppeteer = (await import("puppeteer-core")).default;
			const browser = await puppeteer.launch({
				executablePath: chrome!,
				headless: chrome!.includes("headless-shell") ? "shell" : true,
				args: ["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage"],
			});
			let pdf: Uint8Array;
			try {
				const page = await browser.newPage();
				await page.setContent(html, { waitUntil: "load" });
				pdf = await page.pdf({ format: "letter", printBackground: true, preferCSSPageSize: true });
			} finally {
				await browser.close();
			}

			const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
			const task = pdfjs.getDocument({ data: new Uint8Array(pdf), verbosity: 0 });
			try {
				const doc = await task.promise;
				t.diagnostic(`Chrome printed ${doc.numPages} pages`);
				assert.ok(doc.numPages >= 3, `a long record prints on several pages (got ${doc.numPages})`);
				const label = RECORD_LABEL.replace(/\s+/g, "");
				for (let p = 1; p <= doc.numPages; p++) {
					const page = await doc.getPage(p);
					const content = await page.getTextContent();
					const text = content.items
						.map((item) => ("str" in item ? item.str : ""))
						.join("")
						.replace(/\s+/g, "");
					assert.ok(count(text, label) >= 2, `page ${p} of ${doc.numPages} carries the label at the top and the bottom`);
				}
			} finally {
				await task.destroy();
			}
		},
	);
});
