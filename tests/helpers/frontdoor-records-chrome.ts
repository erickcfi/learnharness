/**
 * Find a Chrome or Chromium binary for the study-record print test
 * (frontdoor-records-print.test.ts): CHROME_PATH first, then the usual
 * system installs. GitHub's ubuntu-24.04 runners ship Google Chrome at
 * /usr/bin/google-chrome, so the test runs in CI. Returns null when none
 * is found; the test then skips and says why.
 *
 * Deliberately no Playwright-cache fallback: a cached Chromium can be
 * present but unable to start (missing system libraries), which would
 * turn a working machine's `npm test` red for no reason.
 */
import fs from "node:fs";
import path from "node:path";

const SYSTEM_CANDIDATES = [
	"/usr/bin/google-chrome",
	"/usr/bin/google-chrome-stable",
	"/usr/bin/chromium",
	"/usr/bin/chromium-browser",
	"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
	"/Applications/Chromium.app/Contents/MacOS/Chromium",
	...(process.platform === "win32"
		? [
				path.join(process.env.PROGRAMFILES ?? "C:\\Program Files", "Google", "Chrome", "Application", "chrome.exe"),
				path.join(process.env["PROGRAMFILES(X86)"] ?? "C:\\Program Files (x86)", "Google", "Chrome", "Application", "chrome.exe"),
			]
		: []),
];

export function findChrome(): string | null {
	for (const candidate of [process.env.CHROME_PATH, ...SYSTEM_CANDIDATES]) {
		if (typeof candidate === "string" && candidate.length > 0 && fs.existsSync(candidate)) return candidate;
	}
	return null;
}
