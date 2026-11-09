/**
 * Render a StudyRecord as one print-ready HTML document (C6 req 1 and 2).
 *
 * THE LABEL ON EVERY PAGE (N8; owner ruling 2026-11-08: top and bottom).
 * The whole record sits in one table whose <thead> and <tfoot> hold the
 * label. Browsers repeat a table's header and footer groups on every
 * printed page the table spans (Chrome, Edge, Firefox), so the label
 * prints at the top and the bottom of each page, and shows at both ends
 * on screen. tests/frontdoor-records-print.test.ts prints a long record
 * in real Chrome and reads every PDF page back to prove it.
 *
 * Every string from upstream (titles, fact names and statements) and the
 * student's name is HTML-escaped. The page loads nothing from outside.
 */
import { RECORD_LABEL, formatDuration, type FactGroup, type RecordFact, type RecordSession, type StudyRecord } from "./build.ts";

function esc(text: string): string {
	return text
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");
}

const CSS = `
:root { color-scheme: light; }
* { box-sizing: border-box; }
html { background: #fff; }
body { margin: 0; color: #111; background: #fff; font: 10.5pt/1.4 -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif; }
table.sheet { width: 100%; border-collapse: collapse; }
table.sheet > thead { display: table-header-group; }
table.sheet > tfoot { display: table-footer-group; }
table.sheet > thead td, table.sheet > tfoot td, table.sheet > tbody > tr > td { padding: 0; }
.label { padding: 5pt 0; font-size: 8.5pt; font-weight: 600; letter-spacing: 0.01em; text-align: center; color: #222; }
.label-top { border-bottom: 1px solid #888; }
.label-bottom { border-top: 1px solid #888; }
.content { padding: 12pt 0; }
.brand { margin: 0; font-size: 9pt; text-transform: uppercase; letter-spacing: 0.08em; color: #555; }
h1 { margin: 2pt 0 8pt; font-size: 18pt; }
h2 { margin: 16pt 0 6pt; font-size: 13pt; break-after: avoid; }
h3 { margin: 10pt 0 4pt; font-size: 11pt; break-after: avoid; }
h3 .date { font-weight: normal; color: #555; }
.facts { display: grid; grid-template-columns: max-content 1fr; gap: 2pt 12pt; margin: 0 0 6pt; }
.facts dt { font-weight: 600; }
.facts dd { margin: 0; }
.note { margin: 4pt 0; font-size: 9pt; color: #444; }
table.sessions { width: 100%; border-collapse: collapse; margin-top: 4pt; }
table.sessions th, table.sessions td { padding: 4pt 6pt; border-bottom: 1px solid #ccc; text-align: left; vertical-align: top; }
table.sessions th { font-size: 9pt; border-bottom: 1px solid #666; }
table.sessions tr { break-inside: avoid; }
td.date, td.length { white-space: nowrap; }
.session-title { font-weight: 600; }
.tag { display: inline-block; margin-left: 4pt; padding: 0 4pt; border: 1px solid #888; border-radius: 3pt; font-size: 8pt; font-weight: normal; }
ul.topics { margin: 2pt 0 0; padding: 0; list-style: none; }
ul.topics li { display: inline; }
ul.topics li + li::before { content: " · "; color: #888; }
ul.topics li.covered > span { font-weight: 600; }
ul.topics li.covered > span::after { content: " ✓"; }
ul.topics li.in-progress > span { text-decoration: underline; }
.fact-list { margin: 0; }
.fact { break-inside: avoid; margin: 0 0 4pt; }
.fact dt { font-weight: 600; }
.fact dd { margin: 0 0 0 12pt; }
@page { size: letter; margin: 0.5in; }
@media screen { body { max-width: 8.5in; margin: 0 auto; padding: 16px; } }
`;

function headerHtml(r: StudyRecord): string {
	const range = r.firstDate === null ? "No sessions yet" : r.firstDate === r.lastDate ? r.firstDate : `${r.firstDate} to ${r.lastDate}`;
	let time = formatDuration(r.studyTime.totalSeconds);
	if (r.studyTime.totalSeconds !== null && r.studyTime.recordedSessions < r.sessionCount) {
		time += ` (recorded for ${r.studyTime.recordedSessions} of ${r.sessionCount} sessions)`;
	}
	const rows: Array<[string, string]> = [
		["Student", r.studentName],
		["Printed", r.printedOn],
		["Dates covered", range],
		["Sessions", String(r.sessionCount)],
		["Study time", time],
		["Facts learned", String(r.learned.totalFacts)],
	];
	return `<header>
<p class="brand">North Aero Ground Tutor</p>
<h1>Study record</h1>
<dl class="facts">${rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join("")}</dl>
<p class="note">Dates are in ${esc(r.timeZone)} time. Study time is active time: the tab was open and in view, and the student acted in the last 5 minutes.</p>
</header>`;
}

function sessionRow(s: RecordSession): string {
	const tag = s.kind === "practice" ? ` <span class="tag">Practice</span>` : "";
	const topics = s.plan && s.plan.topics.length > 0
		? `<ul class="topics">${s.plan.topics.map((t) => `<li class="${t.status}"><span>${esc(t.title)}</span></li>`).join("")}</ul>`
		: "";
	let progress: string;
	if (s.plan) {
		progress = `${s.plan.covered} of ${s.plan.total} covered`;
		if (s.plan.current !== null) progress += `<br>Now on: ${esc(s.plan.current)}`;
	} else {
		progress = s.kind === "practice" ? "Practice session" : "No plan yet";
	}
	return `<tr><td class="date">${esc(s.date)}</td><td class="length">${esc(formatDuration(s.activeSeconds))}</td><td class="session"><div class="session-title">${esc(s.title)}${tag}</div>${topics}</td><td class="progress">${progress}</td></tr>`;
}

function sessionsHtml(r: StudyRecord): string {
	if (r.sessions.length === 0) return `<section><h2>Sessions</h2><p>No study sessions yet.</p></section>`;
	return `<section>
<h2>Sessions</h2>
<table class="sessions">
<thead><tr><th>Date</th><th>Study time</th><th>Session and plan topics</th><th>Plan progress</th></tr></thead>
<tbody>
${r.sessions.map(sessionRow).join("\n")}
</tbody>
</table>
<p class="note">Topics in bold with a check mark are covered. The underlined topic is in progress. The rest are not started yet.</p>
</section>`;
}

function factsHtml(facts: RecordFact[]): string {
	return `<dl class="fact-list">${facts.map((f) => `<div class="fact"><dt>${esc(f.name)}</dt><dd>${esc(f.statement)}</dd></div>`).join("")}</dl>`;
}

function groupHtml(g: FactGroup): string {
	const date = g.date === null ? "" : ` <span class="date">${esc(g.date)}</span>`;
	return `<div class="group"><h3>${esc(g.heading)}${date}</h3>${factsHtml(g.facts)}</div>`;
}

function learnedHtml(r: StudyRecord): string {
	const { sessionGroups, notesGroups, otherFacts, totalFacts } = r.learned;
	if (totalFacts === 0) return `<section><h2>What the student learned</h2><p>No facts in the knowledge graph yet.</p></section>`;
	const parts = [
		`<h2>What the student learned</h2>`,
		`<p class="note">From the student's knowledge graph. Each fact is listed under the session that first taught it.</p>`,
		...sessionGroups.map(groupHtml),
	];
	if (notesGroups.length > 0) {
		parts.push(`<h2>From the student's imported notes</h2>`, `<p class="note">Facts drawn from notes the student imported, not taught in a tutor session.</p>`, ...notesGroups.map(groupHtml));
	}
	if (otherFacts.length > 0) parts.push(`<div class="group"><h3>Source not recorded</h3>${factsHtml(otherFacts)}</div>`);
	return `<section>\n${parts.join("\n")}\n</section>`;
}

export function renderStudyRecordHtml(record: StudyRecord): string {
	const label = esc(RECORD_LABEL);
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Study record: ${esc(record.studentName)}</title>
<style>${CSS}</style>
</head>
<body>
<table class="sheet">
<thead><tr><td><div class="label label-top">${label}</div></td></tr></thead>
<tfoot><tr><td><div class="label label-bottom">${label}</div></td></tr></tfoot>
<tbody><tr><td><div class="content">
${headerHtml(record)}
${sessionsHtml(record)}
${learnedHtml(record)}
</div></td></tr></tbody>
</table>
</body>
</html>
`;
}
