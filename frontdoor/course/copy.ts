/**
 * Every word a student sees on /course (docs/decisions/2026-11-17-course-
 * outline.md). Erick reviews and edits this file. Plain, short sentences,
 * no em dashes. Students see lesson numbers, titles and minutes, never ids.
 */
import { PAUSED_MESSAGE } from "../pause/copy.ts";
import type { StartBlock } from "./blocks.ts";

export const PLANS_PATH = "/account/plans";

export const COURSE_COPY = {
	comingSoonHeading: "Ground school",
	comingSoon: "The course is coming soon. Your tutor can help with any question now.",
	/** The line under the heading. */
	summary: (lessons: number, stages: number) => `${lessons === 1 ? "1 lesson" : `${lessons} lessons`} in ${stages === 1 ? "1 stage" : `${stages} stages`}.`,
	intro: "Start a lesson and your tutor opens a new session for it. It finds out what you already know, then teaches and checks.",
	stage: (number: number, title: string) => `Stage ${number}: ${title}`,
	lesson: (number: number, title: string) => `${number}. ${title}`,
	minutes: ([shortest, longest]: readonly [number, number]) => (shortest === longest ? `About ${shortest} minutes` : `About ${shortest} to ${longest} minutes`),
	start: "Start lesson",
	startAgain: "Start again",
	continue: "Continue",
	started: "Started",
	back: "Back to the tutor",
	errors: {
		"no-lesson": "That lesson is not in the course any more. Choose another one.",
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
