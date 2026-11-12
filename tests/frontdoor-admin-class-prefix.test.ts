/**
 * Ad blockers hide elements whose CSS classes look like ads (ad-main,
 * ad-card, ad-badge). The Owner's dashboard once used the prefix ad-, and a
 * browser with a content blocker showed only its footer. This test fails if
 * any class token under frontdoor/app/ is "ad" or starts with "ad-".
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const APP_DIR = fileURLToPath(new URL("../frontdoor/app/", import.meta.url));
const SOURCE = /\.(?:tsx?|jsx?|mjs|cjs)$/;

function isAdClass(token: string): boolean {
	return token === "ad" || token.startsWith("ad-");
}

/**
 * The text of every string literal and template-literal part in the value
 * that opens at src[start]: a quoted string, a template string, or a JSX
 * {expression} such as {`card${x ? " alert" : ""}`} or {ok ? "a" : "b"}.
 */
function literalParts(src: string, start: number): string[] {
	const parts: string[] = [];
	let i = start;
	function readString(quote: string): void {
		let s = "";
		i++;
		while (i < src.length && src.charAt(i) !== quote) {
			if (src.charAt(i) === "\\") {
				s += src.charAt(i + 1);
				i += 2;
			} else if (quote === "`" && src.startsWith("${", i)) {
				parts.push(s);
				s = "";
				i += 2;
				readExpression();
			} else {
				s += src.charAt(i);
				i++;
			}
		}
		i++;
		parts.push(s);
	}
	// Reads up to and past the "}" that closes the current expression.
	function readExpression(): void {
		let depth = 0;
		while (i < src.length) {
			const ch = src.charAt(i);
			if (ch === '"' || ch === "'" || ch === "`") {
				readString(ch);
				continue;
			}
			i++;
			if (ch === "{") depth++;
			if (ch === "}") {
				if (depth === 0) return;
				depth--;
			}
		}
	}
	const open = src.charAt(start);
	if (open === "{") {
		i++;
		readExpression();
	} else if (open === '"' || open === "'" || open === "`") {
		readString(open);
	}
	return parts;
}

/** Class tokens in the className= and class= values of a script or JSX source. */
function classTokensInSource(src: string): string[] {
	const tokens: string[] = [];
	for (const m of src.matchAll(/\b(?:className|class)\s*=\s*/g)) {
		for (const part of literalParts(src, m.index + m[0].length)) tokens.push(...part.split(/\s+/).filter(Boolean));
	}
	return tokens;
}

/** Class names in the selectors of a stylesheet; comments and declarations are skipped. */
function classTokensInCss(css: string): string[] {
	const tokens: string[] = [];
	let prelude = "";
	for (const ch of css.replace(/\/\*[\s\S]*?\*\//g, "")) {
		if (ch === "{") {
			if (!prelude.trim().startsWith("@")) for (const m of prelude.matchAll(/\.(-?[_a-zA-Z][\w-]*)/g)) tokens.push(m[1] ?? "");
			prelude = "";
		} else if (ch === "}" || ch === ";") {
			prelude = "";
		} else {
			prelude += ch;
		}
	}
	return tokens;
}

function appFiles(dir: string): string[] {
	return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
		const full = path.join(dir, e.name);
		if (e.isDirectory()) return e.name === "node_modules" ? [] : appFiles(full);
		return SOURCE.test(e.name) || e.name.endsWith(".css") ? [full] : [];
	});
}

describe("admin class prefix", () => {
	it("the scanner finds class tokens in strings, templates, conditionals and selectors", () => {
		const jsx = [
			'<div className="ad-card alert">',
			"<span className={`ad-badge ${s.status}`} />",
			"<p className={ok ? \"x\" : 'ad'} />",
			'<i className={`dash-card${a.length ? " ad-x" : ""}`} />',
			'<b className="head-row upload-form pad-2 load-bar" />',
		].join("\n");
		assert.deepEqual(classTokensInSource(jsx), ["ad-card", "alert", "ad-badge", "x", "ad", "dash-card", "ad-x", "head-row", "upload-form", "pad-2", "load-bar"]);
		assert.deepEqual(classTokensInSource(jsx).filter(isAdClass), ["ad-card", "ad-badge", "ad", "ad-x"]);

		const css = ".ad { --ad-bg: #fff; color: var(--ad-bg); font: 16px/1.45 x; }\n/* .ad-gone */\n.ad button, .ad .ad-btn { padding: 0; }\n@media (min-width: 720px) { .ad-grid { gap: 8px; } }\n.load-bar { margin: 0; }";
		assert.deepEqual(classTokensInCss(css), ["ad", "ad", "ad", "ad-btn", "ad-grid", "load-bar"]);
	});

	it("no class token in frontdoor/app is ad or starts with ad-", () => {
		const offenders: string[] = [];
		const seen = new Set<string>();
		for (const file of appFiles(APP_DIR)) {
			const text = fs.readFileSync(file, "utf8");
			const tokens = file.endsWith(".css") ? classTokensInCss(text) : classTokensInSource(text);
			for (const t of tokens) {
				seen.add(t);
				if (isAdClass(t)) offenders.push(`${path.relative(APP_DIR, file)}: ${t}`);
			}
		}
		assert.deepEqual(offenders, [], "ad blockers hide elements with these classes; use the dash- prefix");
		assert.ok(seen.has("dash") && seen.has("dash-main"), "the scanner should see the dashboard's classes");
	});
});
