/**
 * Every word a student sees on /course (master, 2026-11-11). Erick reviews
 * and edits this file. Plain, short sentences, no em dashes. Students see
 * "key points" and titles, never ids.
 */
import { PAUSED_MESSAGE } from "../pause/copy.ts";
import type { StartBlock } from "./blocks.ts";

export const PLANS_PATH = "/account/plans";

export const COURSE_COPY = {
	pageTitle: "Ground school",
	intro: "Short lessons in three stages. Start a lesson and your tutor opens a new session for it. It finds out what you already know, then teaches and checks.",
	comingSoonHeading: "Ground school",
	comingSoon: "The course is coming soon. Your tutor can help with any question now.",
	start: "Start lesson",
	startAgain: "Start again",
	continue: "Continue",
	started: "Started",
	keyPoints: (n: number) => (n === 1 ? "1 key point" : `${n} key points`),
	startedCount: (n: number, total: number) => `${n} of ${total} started`,
	lessons: (n: number) => (n === 1 ? "1 lesson" : `${n} lessons`),
	back: "Back to the tutor",
	errors: {
		"no-leg": "That lesson is not in the course any more. Choose another one.",
		starting: "Your tutor is starting. Try again in a minute.",
	} as Record<string, string>,
};

/** Shown instead of "Start lesson" while a lesson cannot start. */
export const BLOCK_COPY: Record<StartBlock, { text: string; link?: { label: string; href: string } }> = {
	paused: { text: `${PAUSED_MESSAGE} New lessons can start again after that.` },
	"trial-used": { text: "Your free trial is used up. Choose a plan to start new lessons.", link: { label: "Choose a plan", href: PLANS_PATH } },
	"plan-ended": { text: "Your plan has ended. Choose a plan to start new lessons.", link: { label: "Choose a plan", href: PLANS_PATH } },
	"no-plan": { text: "Choose a plan to start lessons.", link: { label: "Choose a plan", href: PLANS_PATH } },
};
