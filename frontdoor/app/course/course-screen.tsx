/* eslint-disable @next/next/no-html-link-for-pages -- the tutor's pages (/, /chat/...) are not this Next.js app's: every link here is a full page load on purpose. */
/**
 * The course page's body (frontdoor/course). Pure: it renders the state the
 * runtime built, so tests render it without the front door. Words come from
 * course/copy.ts; the look is the /account pages' (same widths, type,
 * buttons and notice box). Each stage, its groups as subheadings, and the
 * numbered lessons. Forms post to /course/start without JavaScript.
 * Students see numbers, titles and minutes, never ids (the lesson id rides
 * only in the Start form's hidden field).
 */
import type { CSSProperties } from "react";
import { BLOCK_COPY, COURSE_COPY as C } from "../../course/copy.ts";
import type { LessonView, ShownCoursePage } from "../../course/view.ts";

// The /account pages' styles (app/account/ai-key, app/account/plans).
const main: CSSProperties = { maxWidth: 560, margin: "0 auto", padding: 16, lineHeight: 1.5 };
const muted: CSSProperties = { fontSize: 14, color: "#555" };
const notice: CSSProperties = { background: "#fff7e6", border: "1px solid #f0c36d", borderRadius: 8, padding: 12, margin: "12px 0" };
const button: CSSProperties = { font: "inherit", fontSize: 16, padding: "10px 18px", borderRadius: 8, border: "1px solid #1a1b1d", background: "#1a1b1d", color: "#fff", cursor: "pointer" };
const quiet: CSSProperties = { ...button, background: "#fff", color: "#1a1b1d" };
const linkButton: CSSProperties = { ...button, display: "inline-block", textDecoration: "none" };
const row: CSSProperties = { borderTop: "1px solid #ccc", padding: "12px 0" };

function Lesson({ lesson, canStart }: { lesson: LessonView; canStart: boolean }) {
	return (
		<li style={row}>
			<div>
				<strong>{C.lesson(lesson.number, lesson.title)}</strong>
			</div>
			<div style={muted}>
				{C.minutes(lesson.minutes)}
				{lesson.started && ` · ${C.started}`}
			</div>
			{(lesson.continueChatId || canStart) && (
				<div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 8 }}>
					{lesson.continueChatId && (
						<a href={`/chat/${encodeURIComponent(lesson.continueChatId)}`} style={linkButton}>
							{C.continue}
						</a>
					)}
					{canStart && (
						<form method="post" action="/course/start" style={{ margin: 0 }}>
							<input type="hidden" name="lesson" value={lesson.id} />
							<button type="submit" style={lesson.continueChatId ? quiet : button}>
								{lesson.continueChatId ? C.startAgain : C.start}
							</button>
						</form>
					)}
				</div>
			)}
		</li>
	);
}

export function CourseScreen({ state, error }: { state: ShownCoursePage; error?: string }) {
	const back = (
		<p style={{ marginTop: 24 }}>
			<a href="/">{C.back}</a>
		</p>
	);
	if (state.status === "coming-soon") {
		return (
			<main style={main}>
				<h1 style={{ fontSize: 24 }}>{C.comingSoonHeading}</h1>
				<p>{C.comingSoon}</p>
				{back}
			</main>
		);
	}
	const { course } = state;
	const block = course.block ? BLOCK_COPY[course.block] : null;
	const errorText = error && Object.hasOwn(C.errors, error) ? C.errors[error] : undefined;
	return (
		<main style={main}>
			<h1 style={{ fontSize: 24, marginBottom: 4 }}>{course.title}</h1>
			<p style={{ ...muted, marginTop: 0 }}>{C.summary(course.lessonCount, course.stages.length)}</p>
			<p>{C.intro}</p>
			{errorText && (
				<p role="alert" style={notice}>
					{errorText}
				</p>
			)}
			{block && (
				// Cards fallback (Erick, 2026-11-11): a paused student or one at a budget cap would be offered
				// pre-written question cards here once that mode exists. Not built in this version.
				<p role="status" style={notice}>
					{block.text}
					{block.link && (
						<>
							{" "}
							<a href={block.link.href}>{block.link.label}</a>
						</>
					)}
				</p>
			)}
			{course.stages.map((stage) => (
				<section key={stage.number} style={{ marginTop: 32 }}>
					<h2 style={{ fontSize: 20, marginBottom: 0 }}>{C.stage(stage.number, stage.title)}</h2>
					{stage.groups.map((group, i) => (
						<section key={`${stage.number}-${i}`}>
							<h3 style={{ fontSize: 17, margin: "20px 0 4px" }}>{group.title}</h3>
							<ol style={{ listStyle: "none", padding: 0, margin: 0 }}>
								{group.lessons.map((lesson) => (
									<Lesson key={lesson.id} lesson={lesson} canStart={!block} />
								))}
							</ol>
						</section>
					))}
				</section>
			))}
			{back}
		</main>
	);
}
