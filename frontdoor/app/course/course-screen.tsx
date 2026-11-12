/* eslint-disable @next/next/no-html-link-for-pages -- the tutor's pages (/, /chat/...) are not this Next.js app's: every link here is a full page load on purpose. */
/**
 * The course page's body (frontdoor/course). Pure: it renders the state the
 * runtime built, so tests render it without the front door. Words come from
 * course/copy.ts. Forms post to /course/start without JavaScript; subjects
 * open and close with <details>. Students see titles, outcomes and "key
 * points", never ids (the Leg id rides only in the Start form's hidden field).
 */
import type { CSSProperties } from "react";
import { BLOCK_COPY, COURSE_COPY as C } from "../../course/copy.ts";
import type { LegView, ShownCoursePage, SubjectView } from "../../course/view.ts";

const main: CSSProperties = { maxWidth: 720, margin: "0 auto", padding: 16, lineHeight: 1.5 };
const muted: CSSProperties = { color: "#555", fontSize: 14 };
const notice: CSSProperties = { background: "#fff7e6", border: "1px solid #f0c36d", borderRadius: 8, padding: 12, margin: "12px 0" };
const button: CSSProperties = { font: "inherit", fontSize: 15, padding: "8px 16px", borderRadius: 8, border: "1px solid #1a1b1d", background: "#1a1b1d", color: "#fff", cursor: "pointer" };
const quietButton: CSSProperties = { ...button, background: "#fff", color: "#1a1b1d" };
const linkButton: CSSProperties = { ...button, display: "inline-block", textDecoration: "none" };
const badge: CSSProperties = { display: "inline-block", fontSize: 12, padding: "1px 8px", borderRadius: 999, background: "#e7f3ea", color: "#1d5b2c", marginLeft: 8 };
const card: CSSProperties = { borderTop: "1px solid #ddd", padding: "12px 0" };

function Leg({ leg, canStart }: { leg: LegView; canStart: boolean }) {
	return (
		<li style={card}>
			<div>
				<strong>{leg.title}</strong>
				{leg.started && <span style={badge}>{C.started}</span>}
			</div>
			<div>{leg.outcome}</div>
			<div style={muted}>{C.keyPoints(leg.keyPointCount)}</div>
			<div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 8 }}>
				{leg.started && (
					<a href={`/chat/${encodeURIComponent(leg.started.chatId)}`} style={linkButton}>
						{C.continue}
					</a>
				)}
				{canStart && (
					<form method="post" action="/course/start" style={{ margin: 0 }}>
						<input type="hidden" name="leg" value={leg.id} />
						<button type="submit" style={leg.started ? quietButton : button}>
							{leg.started ? C.startAgain : C.start}
						</button>
					</form>
				)}
			</div>
		</li>
	);
}

function Subject({ subject, canStart }: { subject: SubjectView; canStart: boolean }) {
	return (
		<details style={{ margin: "8px 0", border: "1px solid #ddd", borderRadius: 8, padding: "8px 12px" }}>
			<summary style={{ cursor: "pointer", fontWeight: 600 }}>
				{subject.title}{" "}
				<span style={{ ...muted, fontWeight: 400 }}>
					{C.lessons(subject.legs.length)}
					{subject.startedCount > 0 ? ` · ${C.startedCount(subject.startedCount, subject.legs.length)}` : ""}
				</span>
			</summary>
			<ol style={{ listStyle: "none", padding: 0, margin: "8px 0 0" }}>
				{subject.legs.map((leg) => (
					<Leg key={leg.id} leg={leg} canStart={canStart} />
				))}
			</ol>
		</details>
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
			<p style={{ marginTop: 0 }}>{C.intro}</p>
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
				<section key={stage.id} style={{ marginTop: 24 }}>
					<h2 style={{ fontSize: 20, marginBottom: 8 }}>{stage.title}</h2>
					{stage.subjects.map((subject) => (
						<Subject key={`${stage.id}/${subject.id}`} subject={subject} canStart={!block} />
					))}
				</section>
			))}
			{back}
		</main>
	);
}
