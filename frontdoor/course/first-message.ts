/**
 * The first message of a course lesson (docs/decisions/2026-11-17-course-
 * outline.md; Erick, 2026-11-09: "prompt like a well-prepared student. Who
 * the student is, the lesson goal, and the ACS elements in the FAA's own
 * wording."). It is the only course input the tutor gets. The tutor then
 * teaches its own way (PRD D2: probe, plan, teach, check); its prompts and
 * tools are unchanged.
 *
 * Generic for a student anywhere: no aircraft, airport, hours or solo claims
 * about the student. Nothing else either: no hidden rules, no "not part of
 * this lesson" list. The student sees it as their own first message in the
 * chat, so it is written in the first person and holds no ids.
 *
 *   I am a student pilot working toward the FAA private pilot certificate. ...
 *
 *   Lesson 5: <title>
 *   Stage 1: <stage title>
 *
 *   From the Private Pilot ACS (FAA-S-ACS-6C), Task I.B, <Task name>. I should understand:
 *   - K1 <FAA text>
 *     - K1a <FAA text>
 *   And be able to identify, assess, and mitigate risk associated with:
 *   - R1 <FAA text>
 *
 * One such block per Task. 14 CFR paragraphs get one block per Part.
 *
 * The message travels in the chat address (/chat/<id>?prompt=...), so the
 * course file check refuses a lesson whose message would not fit
 * (MAX_START_URL_BYTES).
 *
 * Plain Node: type-only imports.
 */
import type { AcsElement, AcsTask, CourseLesson, CourseStage, RegSection } from "./file.ts";

export const STUDENT_LINE = "I am a student pilot working toward the FAA private pilot certificate. I would like to work on this lesson.";
export const ACS_NAME = "the Private Pilot ACS (FAA-S-ACS-6C)";
export const K_LEAD = "I should understand:";
export const R_LEAD = "And be able to identify, assess, and mitigate risk associated with:";
/** For a Task with risk elements only. */
export const R_ONLY_LEAD = "I should be able to identify, assess, and mitigate risk associated with:";
export const REGS_NOTE = "(the ACS does not cover these rules)";

/** The longest address /course/start may send a student to (6 KB). */
export const MAX_START_URL_BYTES = 6 * 1024;
/** The longest chat id the front door accepts (admin/tenant-api.ts CHAT_ID). */
const MAX_CHAT_ID = 128;

/** The size of /chat/<id>?prompt=<message> for the longest chat id. */
export function startUrlBytes(message: string): number {
	return "/chat/".length + MAX_CHAT_ID + "?prompt=".length + encodeURIComponent(message).length;
}

/** "PA.I.B.K1a" -> "K1a". */
const shortCode = (code: string) => code.slice(code.lastIndexOf(".") + 1);

/** Element lines, a sub-element indented under its parent line. */
function elementLines(elements: readonly AcsElement[]): string[] {
	return elements.map((e) => `${e.sub ? "  " : ""}- ${shortCode(e.code)} ${e.text}`);
}

function taskBlock(task: AcsTask): string[] {
	// "PA.I.B" -> "I.B", as the ACS itself names a Task.
	const lead = `From ${ACS_NAME}, Task ${task.task.slice(task.task.indexOf(".") + 1)}, ${task.name}.`;
	const k = task.elements.filter((e) => e.type === "K");
	const r = task.elements.filter((e) => e.type === "R");
	if (k.length === 0) return [`${lead} ${R_ONLY_LEAD}`, ...elementLines(r)];
	return [`${lead} ${K_LEAD}`, ...elementLines(k), ...(r.length ? [R_LEAD, ...elementLines(r)] : [])];
}

/** "14 CFR 61.87" -> { part: "14 CFR Part 61", section: "61.87" }. */
function splitCite(cite: string): { part: string; section: string } {
	const [title = "", , section = ""] = cite.split(" ");
	return { part: `${title} CFR Part ${section.split(".")[0]}`, section };
}

function regBlocks(regs: readonly RegSection[]): string[][] {
	const byPart = new Map<string, string[]>();
	for (const reg of regs) {
		const { part, section } = splitCite(reg.cite);
		const lines = byPart.get(part) ?? [];
		if (reg.paragraphs.length === 0) lines.push(`- ${section} ${reg.heading}`);
		else lines.push(`- ${section} ${reg.heading}:`, ...reg.paragraphs.map((p) => `  - ${p.cite.slice(reg.cite.length)} ${p.heading}`));
		byPart.set(part, lines);
	}
	return [...byPart].map(([part, lines]) => [`From ${part} ${REGS_NOTE}:`, ...lines]);
}

export function firstMessage(found: { lesson: CourseLesson; stage: CourseStage; stageNumber: number }): string {
	const { lesson, stage, stageNumber } = found;
	const blocks = [[STUDENT_LINE], [`Lesson ${lesson.number}: ${lesson.title}`, `Stage ${stageNumber}: ${stage.title}`], ...lesson.acs.map(taskBlock), ...regBlocks(lesson.regs)];
	return blocks.map((lines) => lines.join("\n")).join("\n\n");
}
