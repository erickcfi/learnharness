/**
 * The look of every email (C6, brand of flynorthaero.com: cream, ink,
 * orange; the "NORTH AERO / GROUND TUTOR" wordmark). One document model
 * gives both parts, so the HTML and the plain text always say the same.
 *
 * Built for phones and plain mail apps: one column at most 560 px wide,
 * inline styles only (many mail apps drop <style>), tables for layout, no
 * images, no scripts, no web fonts required, no tracking.
 */

export type Block =
	| { kind: "paragraph"; text: string }
	| { kind: "heading"; text: string }
	/** Label and value rows, e.g. Date and Study time. */
	| { kind: "rows"; rows: ReadonlyArray<{ label: string; value: string }> }
	/** One card per study session: a title and short lines under it. */
	| { kind: "card"; title: string; lines: readonly string[] }
	/** A bullet list. Each item may have a bold lead. */
	| { kind: "list"; items: ReadonlyArray<{ lead?: string; text: string }> };

export interface EmailLink {
	text: string;
	href: string;
}

export interface EmailDocument {
	/** The <title> and the big heading. */
	title: string;
	/** Hidden preview text that mail apps show after the subject. */
	preheader: string;
	/** N8 label, shown at the top and the bottom when set. */
	label?: string;
	blocks: readonly Block[];
	footer: { links: readonly EmailLink[]; lines: readonly string[] };
}

export const EMAIL_COLORS = {
	cream: "#faf6ec",
	card: "#fffdf8",
	line: "#e2dac6",
	ink: "#1a1b1d",
	gray: "#4f5256",
	orange: "#e86a28",
	/** Orange dark enough for text on cream (WCAG AA). */
	orangeText: "#b5430e",
	peachPale: "#fbe4d2",
} as const;

const C = EMAIL_COLORS;
const BODY_FONT = "Helvetica, Arial, sans-serif";
const DISPLAY_FONT = "Oswald, 'Arial Narrow', Arial, sans-serif";

export function escapeHtml(value: string): string {
	return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

/** One line of text: no line breaks or control characters from student data. */
export function oneLine(value: string): string {
	return value.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
}

const p = (html: string, extra = "") => `<p style="margin:0 0 12px;font-size:16px;line-height:1.5;color:${C.ink};${extra}">${html}</p>`;

function blockHtml(block: Block): string {
	switch (block.kind) {
		case "paragraph":
			return p(escapeHtml(block.text));
		case "heading":
			return `<h2 style="margin:20px 0 8px;font-family:${DISPLAY_FONT};font-size:18px;line-height:1.3;letter-spacing:0.04em;text-transform:uppercase;color:${C.ink};">${escapeHtml(block.text)}</h2>`;
		case "rows":
			return `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 12px;border-collapse:collapse;">${block.rows
				.map(
					(r) =>
						`<tr><td style="padding:2px 12px 2px 0;font-size:15px;color:${C.gray};vertical-align:top;">${escapeHtml(r.label)}</td><td style="padding:2px 0;font-size:15px;font-weight:bold;color:${C.ink};vertical-align:top;">${escapeHtml(r.value)}</td></tr>`,
				)
				.join("")}</table>`;
		case "card":
			return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 10px;border-collapse:collapse;"><tr><td style="padding:10px 12px;background:${C.cream};border-left:3px solid ${C.orange};"><div style="font-size:16px;font-weight:bold;line-height:1.4;color:${C.ink};">${escapeHtml(block.title)}</div>${block.lines
				.map((line) => `<div style="font-size:14px;line-height:1.5;color:${C.gray};">${escapeHtml(line)}</div>`)
				.join("")}</td></tr></table>`;
		case "list":
			return `<ul style="margin:0 0 12px;padding:0 0 0 20px;">${block.items
				.map(
					(item) =>
						`<li style="margin:0 0 6px;font-size:15px;line-height:1.5;color:${C.ink};">${item.lead ? `<strong>${escapeHtml(item.lead)}</strong>: ` : ""}${escapeHtml(item.text)}</li>`,
				)
				.join("")}</ul>`;
	}
}

function labelHtml(label: string): string {
	return `<div style="margin:0;padding:8px 12px;background:${C.peachPale};font-size:13px;line-height:1.4;color:${C.ink};">${escapeHtml(label)}</div>`;
}

export function renderEmailHtml(doc: EmailDocument): string {
	const links = doc.footer.links
		.map((l) => `<a href="${escapeHtml(l.href)}" style="color:${C.orangeText};text-decoration:underline;">${escapeHtml(l.text)}</a>`)
		.join(`<span style="color:${C.line};"> &nbsp;|&nbsp; </span>`);
	return [
		"<!doctype html>",
		'<html lang="en">',
		'<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="light"><meta name="supported-color-schemes" content="light">',
		`<title>${escapeHtml(doc.title)}</title></head>`,
		`<body style="margin:0;padding:0;background:${C.cream};color:${C.ink};font-family:${BODY_FONT};">`,
		`<div style="display:none;max-height:0;max-width:0;overflow:hidden;opacity:0;">${escapeHtml(doc.preheader)}</div>`,
		`<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${C.cream};border-collapse:collapse;"><tr><td align="center" style="padding:16px 12px;">`,
		`<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:${C.card};border:1px solid ${C.line};border-top:4px solid ${C.orange};border-collapse:collapse;">`,
		`<tr><td style="padding:18px 20px 6px;font-family:${DISPLAY_FONT};font-size:14px;font-weight:bold;letter-spacing:0.12em;color:${C.ink};">NORTH AERO <span style="color:${C.orangeText};">/ GROUND TUTOR</span></td></tr>`,
		doc.label ? `<tr><td style="padding:8px 20px 0;">${labelHtml(doc.label)}</td></tr>` : "",
		`<tr><td style="padding:16px 20px 8px;font-family:${BODY_FONT};">`,
		`<h1 style="margin:0 0 12px;font-family:${DISPLAY_FONT};font-size:24px;line-height:1.25;color:${C.ink};">${escapeHtml(doc.title)}</h1>`,
		doc.blocks.map(blockHtml).join(""),
		"</td></tr>",
		doc.label ? `<tr><td style="padding:0 20px 8px;">${labelHtml(doc.label)}</td></tr>` : "",
		`<tr><td style="padding:12px 20px 20px;border-top:1px solid ${C.line};font-family:${BODY_FONT};">`,
		links ? p(links, "font-size:14px;") : "",
		doc.footer.lines.map((line) => p(escapeHtml(line), `font-size:13px;color:${C.gray};margin:0 0 6px;`)).join(""),
		"</td></tr>",
		"</table>",
		"</td></tr></table>",
		"</body></html>",
	].join("\n");
}

function blockText(block: Block): string {
	switch (block.kind) {
		case "paragraph":
			return block.text;
		case "heading":
			return block.text.toUpperCase();
		case "rows":
			return block.rows.map((r) => `${r.label}: ${r.value}`).join("\n");
		case "card":
			return [`* ${block.title}`, ...block.lines.map((line) => `  ${line}`)].join("\n");
		case "list":
			return block.items.map((item) => `- ${item.lead ? `${item.lead}: ` : ""}${item.text}`).join("\n");
	}
}

export function renderEmailText(doc: EmailDocument): string {
	const parts: string[] = ["NORTH AERO / GROUND TUTOR", ""];
	if (doc.label) parts.push(doc.label, "");
	parts.push(doc.title, "");
	for (const block of doc.blocks) parts.push(blockText(block), "");
	if (doc.label) parts.push(doc.label, "");
	parts.push("--");
	for (const link of doc.footer.links) parts.push(`${link.text}: ${link.href}`);
	if (doc.footer.links.length > 0 && doc.footer.lines.length > 0) parts.push("");
	parts.push(...doc.footer.lines);
	return `${parts.join("\n").trimEnd()}\n`;
}
