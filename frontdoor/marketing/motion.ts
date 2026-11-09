/**
 * Motion rules for the tutor screen animations (W2-11).
 *
 * A screen is in one of three states, set on its `data-motion` attribute:
 *   still    the final frame, no animation. What the server sends, what a
 *            browser without JavaScript shows, and what a visitor who asks
 *            for reduced motion keeps.
 *   armed    animations set to their first frame, waiting to be seen.
 *   playing  animations running (once).
 * The CSS (marketing.css) animates only inside
 * `@media (prefers-reduced-motion: no-preference)`, so reduced motion shows
 * still frames even if a script misbehaves.
 *
 * Framework-free.
 */

export type MotionState = "still" | "armed" | "playing";

export const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

interface MediaWindow {
	matchMedia?: (query: string) => { matches: boolean };
}

/** True only when the browser can tell us motion is fine. */
export function motionAllowed(win: MediaWindow | undefined = typeof window === "undefined" ? undefined : window): boolean {
	if (!win || typeof win.matchMedia !== "function") return false;
	try {
		return !win.matchMedia(REDUCED_MOTION_QUERY).matches;
	} catch {
		return false;
	}
}
