/**
 * What the /course page shows (master, 2026-11-11): stages, then subjects,
 * then Legs, each with its title and outcome, and a "Started" mark with the
 * chat to continue. Plain data, so course-screen.tsx stays a pure render.
 */
import type { StartBlock } from "./blocks.ts";
import type { CourseFile } from "./file.ts";
import type { LatestStart } from "./marks.ts";

export interface LegView {
	/** Sent back by the Start form only; never shown. */
	id: string;
	title: string;
	outcome: string;
	keyPointCount: number;
	started: LatestStart | null;
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

export function courseView(course: CourseFile, marks: ReadonlyMap<string, LatestStart>, block: StartBlock | null): CourseView {
	return {
		title: course.title,
		block,
		stages: course.stages.map((stage) => ({
			id: stage.id,
			title: stage.title,
			subjects: stage.subjects.map((subject) => {
				const legs = subject.legs.map((leg) => ({
					id: leg.id,
					title: leg.title,
					outcome: leg.outcome,
					keyPointCount: leg.keyPoints.length,
					started: marks.get(leg.id) ?? null,
				}));
				return { id: subject.id, title: subject.title, legs, startedCount: legs.filter((l) => l.started).length };
			}),
		})),
	};
}
