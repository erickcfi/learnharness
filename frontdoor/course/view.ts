/**
 * What the /course page shows (master, 2026-11-11): stages, then subjects,
 * then Legs, each with its title and outcome, and a "Started" mark with the
 * chat to continue. Plain data, so course-screen.tsx stays a pure render.
 */
import type { StartBlock } from "./blocks.ts";
import type { CourseFile } from "./file.ts";
import type { StartMark } from "./marks.ts";

export interface LegView {
	/** Sent back by the Start form only; never shown. */
	id: string;
	title: string;
	outcome: string;
	keyPointCount: number;
	/** The newest start: the "Started" mark. */
	started: StartMark | null;
	/** The chat "Continue" opens, or null: then the Leg offers "Start lesson" again. */
	continueChatId: string | null;
}

export interface SubjectView {
	id: string;
	title: string;
	legs: LegView[];
	startedCount: number;
}

export interface StageView {
	id: string;
	title: string;
	subjects: SubjectView[];
}

export interface CourseView {
	title: string;
	stages: StageView[];
	/** Why a lesson cannot start now, or null. */
	block: StartBlock | null;
}

export type CoursePageState = { status: "sign-in" } | { status: "confirm-age" } | { status: "coming-soon" } | { status: "ready"; course: CourseView };
export type ShownCoursePage = Extract<CoursePageState, { status: "coming-soon" | "ready" }>;

/** Where the page sends a student with no login, or with no 18+ tick on file (as the /account pages do). Null: show the page. */
export function courseRedirect(state: CoursePageState): string | null {
	const next = encodeURIComponent("/course");
	if (state.status === "sign-in") return `/account/sign-in?next=${next}`;
	if (state.status === "confirm-age") return `/account/confirm-age?next=${next}`;
	return null;
}

/**
 * The chat "Continue" opens for one Leg. `starts` is newest first. A chat the
 * student deleted in the tutor is skipped for the newest earlier one that
 * still exists; none left gives null. `liveChats` null means the tenant's
 * server did not answer: then the newest start, as before.
 */
export function chatToContinue(starts: readonly StartMark[], liveChats: ReadonlySet<string> | null): string | null {
	if (!liveChats) return starts[0]?.chatId ?? null;
	return starts.find((start) => liveChats.has(start.chatId))?.chatId ?? null;
}

export function courseView(course: CourseFile, starts: ReadonlyMap<string, readonly StartMark[]>, block: StartBlock | null, liveChats: ReadonlySet<string> | null = null): CourseView {
	return {
		title: course.title,
		block,
		stages: course.stages.map((stage) => ({
			id: stage.id,
			title: stage.title,
			subjects: stage.subjects.map((subject) => {
				const legs = subject.legs.map((leg) => {
					const legStarts = starts.get(leg.id) ?? [];
					return {
						id: leg.id,
						title: leg.title,
						outcome: leg.outcome,
						keyPointCount: leg.keyPoints.length,
						started: legStarts[0] ?? null,
						continueChatId: chatToContinue(legStarts, liveChats),
					};
				});
				return { id: subject.id, title: subject.title, legs, startedCount: legs.filter((l) => l.started).length };
			}),
		})),
	};
}
