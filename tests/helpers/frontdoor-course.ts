/**
 * Invented course data for the course tests (docs/decisions/2026-11-17-
 * course-outline.md): a tiny course about kites. The real outline never
 * goes in this repo. sampleCourse() is exactly what build-course-file.ts
 * writes from tests/fixtures/frontdoor-course/outline/ (a test checks it).
 */
import * as path from "node:path";
import { COURSE_FORMAT, COURSE_VERSION, type CourseFile } from "../../frontdoor/course/file.ts";

export const SAMPLE_OUTLINE_DIR = path.join(import.meta.dirname, "..", "fixtures", "frontdoor-course", "outline");
export const SAMPLE_OUTLINE = path.join(SAMPLE_OUTLINE_DIR, "outline.json");
export const SAMPLE_ACS = path.join(SAMPLE_OUTLINE_DIR, "acs.json");
export const SAMPLE_REGS = path.join(SAMPLE_OUTLINE_DIR, "regs.json");

/** Two stages, four groups, five lessons: one Task, a context parent line, two Tasks, regulations only, and lines out of ACS order. */
export function sampleCourse(): CourseFile {
	return {
		format: COURSE_FORMAT,
		version: COURSE_VERSION,
		id: "private-pilot",
		title: "Private pilot ground school",
		stages: [
			{
				title: "Before the first flight",
				groups: [
					{
						title: "Picking a kite",
						lessons: [
							{
								id: "l01",
								number: 1,
								title: "Kite shapes and line",
								minutes: [20, 30],
								acs: [
									{
										task: "ZZ.I.A",
										name: "Kite Selection",
										elements: [
											{ code: "ZZ.I.A.K1", type: "K", text: "Kite shapes and sizes, including:", sub: false },
											{ code: "ZZ.I.A.K1a", type: "K", text: "Diamond kites", sub: true },
											{ code: "ZZ.I.A.K1b", type: "K", text: "Box kites", sub: true },
											{ code: "ZZ.I.A.K2", type: "K", text: "Line strength and weight.", sub: false },
										],
									},
								],
								regs: [],
							},
							{
								id: "l02",
								number: 2,
								title: "Reels, gloves, and big kites",
								minutes: [15, 25],
								acs: [
									{
										task: "ZZ.I.A",
										name: "Kite Selection",
										elements: [
											{ code: "ZZ.I.A.K1", type: "K", text: "Kite shapes and sizes, including:", sub: false, context: true },
											{ code: "ZZ.I.A.K1c", type: "K", text: "Delta kites", sub: true },
											{ code: "ZZ.I.A.R1", type: "R", text: "Choosing a kite too large for the wind.", sub: false },
											{ code: "ZZ.I.A.R2", type: "R", text: "Use and limitations of:", sub: false },
											{ code: "ZZ.I.A.R2a", type: "R", text: "Reels", sub: true },
											{ code: "ZZ.I.A.R2b", type: "R", text: "Gloves", sub: true },
										],
									},
								],
								regs: [],
							},
						],
					},
					{
						title: "The field",
						lessons: [
							{
								id: "l03",
								number: 3,
								title: "Where to fly",
								minutes: [20, 35],
								acs: [
									{
										task: "ZZ.I.B",
										name: "Launch Site",
										elements: [
											{ code: "ZZ.I.B.K1", type: "K", text: "Power lines, trees, and other obstructions.", sub: false },
											{ code: "ZZ.I.B.R1", type: "R", text: "Launching near people or roads.", sub: false },
										],
									},
									{ task: "ZZ.II.A", name: "Launching", elements: [{ code: "ZZ.II.A.K2", type: "K", text: "The wind window.", sub: false }] },
								],
								regs: [],
							},
						],
					},
				],
			},
			{
				title: "Flying",
				groups: [
					{
						title: "Kite rules",
						lessons: [
							{
								id: "l04",
								number: 4,
								title: "Kite rules near airports",
								minutes: [10, 20],
								acs: [],
								regs: [
									{
										cite: "14 CFR 199.5",
										heading: "Kites near airports",
										paragraphs: [
											{ cite: "14 CFR 199.5(a)", heading: "Line length" },
											{ cite: "14 CFR 199.5(b)", heading: "Distance from a runway" },
										],
									},
									{ cite: "14 CFR 199.7", heading: "Lights on kites at night", paragraphs: [] },
								],
							},
						],
					},
					{
						title: "Launching",
						lessons: [
							{
								id: "l05",
								number: 5,
								title: "Launching",
								minutes: [25, 25],
								acs: [
									{
										task: "ZZ.II.A",
										name: "Launching",
										elements: [
											{ code: "ZZ.II.A.K1", type: "K", text: "Running launch and assisted launch.", sub: false },
											{ code: "ZZ.II.A.R1", type: "R", text: "Line burns.", sub: false },
										],
									},
								],
								regs: [],
							},
						],
					},
				],
			},
		],
	};
}

export const sampleCourseBytes = () => Buffer.from(JSON.stringify(sampleCourse(), null, 2));

/**
 * A course file of the earlier design (version 1: stages of subjects, each
 * with short lessons, outcomes and point labels), invented, so the tests
 * can check that it is refused with a plain message.
 */
export function oldCourseFile(): Record<string, unknown> {
	return {
		format: COURSE_FORMAT,
		version: 1,
		id: "sample-course",
		title: "Sample ground school",
		stages: [
			{
				id: "solo",
				title: "Before you solo",
				subjects: [{ id: "paper-planes", title: "Paper planes", legs: [{ id: "folding-the-dart", title: "Folding the dart", outcome: "Fold a dart that flies straight.", acs: ["ZZ.I.A.K1"], keyPoints: ["The center fold"] }] }],
			},
		],
	};
}
