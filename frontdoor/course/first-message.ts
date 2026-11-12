/**
 * The first message of a course lesson (master, 2026-11-11; Erick,
 * 2026-11-09). It is the only course input the tutor gets. The tutor then
 * teaches its own way (PRD D2: probe, plan, teach, check); its prompts and
 * tools are unchanged.
 *
 * Kept minimal on purpose: who the student is, the Leg's title and outcome,
 * the ACS codes it covers, and the short key point labels as "this lesson
 * should cover". Never key point statements, source passages or quizzes:
 * those are under review and must not reach students yet. The course file
 * cannot carry them anyway (file.ts refuses unknown fields).
 *
 * The student sees this message as their own first message in the chat, so
 * it is written in the first person and holds no ids.
 */
import type { CourseLeg } from "./file.ts";

export const STUDENT_LINE = "I am a student pilot working toward the private pilot certificate. I would like to work on this lesson.";

export function firstMessage(leg: CourseLeg): string {
	const lines = [STUDENT_LINE, "", `Lesson: ${leg.title}`, `Outcome: ${leg.outcome}`];
	// Codes only: Groundwork's data has no FAA wording for them. Joined with "; " because some codes hold commas.
	if (leg.acs.length > 0) lines.push(`ACS: ${leg.acs.join("; ")}`);
	if (leg.keyPoints.length > 0) lines.push("", "This lesson should cover:", ...leg.keyPoints.map((label) => `- ${label}`));
	return lines.join("\n");
}
