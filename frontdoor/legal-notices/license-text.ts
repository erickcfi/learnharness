import * as fs from "node:fs";
import * as path from "node:path";

/**
 * The repository's LICENSE (the AGPL-3.0, unchanged from upstream), read on
 * the server. The /legal/license page is built once at build time, when the
 * working folder is either the repository root (tests) or frontdoor/ (the
 * front door's `next build`). The front door has no "standalone" output, so
 * file tracing does not matter here; the comments keep Turbopack from
 * tracing the whole project. A missing file fails the build loudly, so the
 * site can never ship without the license text.
 */
export function licenseText(cwd: string = process.cwd()): string {
	const candidates = [path.join(/* turbopackIgnore: true */ cwd, "LICENSE"), path.join(/* turbopackIgnore: true */ cwd, "..", "LICENSE")];
	for (const candidate of candidates) {
		if (!fs.existsSync(candidate)) continue;
		const text = fs.readFileSync(candidate, "utf8");
		if (text.includes("GNU AFFERO GENERAL PUBLIC LICENSE")) return text;
	}
	throw new Error("LICENSE (AGPL-3.0) not found next to the front door; the license page cannot be built without it.");
}
