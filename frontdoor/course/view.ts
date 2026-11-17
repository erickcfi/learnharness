/**
 * What the /course page shows (docs/decisions/2026-11-17-course-outline.md):
 * each stage, its groups, and their numbered lessons with title and minutes,
 * plus a "Started" mark with the chat to continue. Plain data, so
 * course-screen.tsx stays a pure render. The lesson's scope (ACS elements,
 * regulations) is for the tutor's first message only, so it is not here.
 */
import type { StartBlock } from "./blocks.ts";
import { allLessons, type CourseFile } from "./file.ts";
import type { StartMark } from "./marks.ts";

export interface LessonView {
	/** Sent back by the Start form only; never shown. */
	id: string;
	number: number;
	title: string;
	minutes: [number, number];
	/** The newest start: the "Started" mark. */
	started: StartMark | null;
	/** The chat "Continue" opens, or null: then the lesson offers "Start lesson" again. */
	continueChatId: string | null;
}

export interface GroupView {
	title: string;
	lessons: LessonView[];
}

export interface StageView {
	/** 1, 2, 3. */
	number: number;
	title: string;
	groups: GroupView[];
}

export interface CourseView {
	title: string;
	lessonCount: number;
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
 * The chat "Continue" opens for one lesson. `starts` is newest first. A chat
 * the student deleted in the tutor is skipped for the newest earlier one
 * that still exists; none left gives null. `liveChats` null means the
 * tenant's server did not answer: then the newest start, as before.
 */
export function chatToContinue(starts: readonly StartMark[], liveChats: ReadonlySet<string> | null): string | null {
	if (!liveChats) return starts[0]?.chatId ?? null;
	return starts.find((start) => liveChats.has(start.chatId))?.chatId ?? null;
}

export function courseView(course: CourseFile, starts: ReadonlyMap<string, readonly StartMark[]>, block: StartBlock | null, liveChats: ReadonlySet<string> | null = null): CourseView {
	return {
		title: course.title,
		lessonCount: allLessons(course).length,
		block,
		stages: course.stages.map((stage, i) => ({
			number: i + 1,
			title: stage.title,
			groups: stage.groups.map((group) => ({
				title: group.title,
				lessons: group.lessons.map((lesson) => {
					const lessonStarts = starts.get(lesson.id) ?? [];
					return {
						id: lesson.id,
						number: lesson.number,
						title: lesson.title,
						minutes: lesson.minutes,
						started: lessonStarts[0] ?? null,
						continueChatId: chatToContinue(lessonStarts, liveChats),
					};
				}),
			})),
		})),
	};
}
