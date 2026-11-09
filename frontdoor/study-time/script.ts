/**
 * The heartbeat script for the tutor's pages (PD1). The front door serves it
 * at ACTIVITY_SCRIPT_PATH. Every HEARTBEAT_SECONDS it posts the current
 * upstream chat id to ACTIVITY_PATH, but only while the tab is visible and
 * the student pressed a key, clicked, touched, scrolled or moved the mouse
 * in the last 5 minutes. It sends no page text, only the path.
 */
import { ACTIVE_WINDOW_SECONDS, HEARTBEAT_SECONDS } from "./credit.ts";

export const ACTIVITY_PATH = "/_frontdoor/activity";
export const ACTIVITY_SCRIPT_PATH = "/_frontdoor/activity.js";

export const ACTIVITY_SCRIPT = `(() => {
	"use strict";
	if (window.__fdActivity) return;
	window.__fdActivity = true;
	const WINDOW_MS = ${ACTIVE_WINDOW_SECONDS * 1000};
	const BEAT_MS = ${HEARTBEAT_SECONDS * 1000};
	let lastInput = Date.now();
	const mark = () => { lastInput = Date.now(); };
	for (const type of ["keydown", "pointerdown", "pointermove", "touchstart", "wheel", "scroll"]) {
		window.addEventListener(type, mark, { passive: true, capture: true });
	}
	const beat = () => {
		if (document.visibilityState !== "visible") return;
		if (Date.now() - lastInput > WINDOW_MS) return;
		const body = JSON.stringify({ path: location.pathname });
		fetch(${JSON.stringify(ACTIVITY_PATH)}, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body,
			credentials: "same-origin",
			keepalive: true,
		}).catch(() => {});
	};
	setInterval(beat, BEAT_MS);
	document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") mark(); });
})();
`;
