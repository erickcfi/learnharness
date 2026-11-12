/**
 * Invented course data for the course tests (master, 2026-11-11). The real
 * course never goes in this repo.
 */
import * as path from "node:path";
import { COURSE_FORMAT, COURSE_VERSION, type CourseFile } from "../../frontdoor/course/file.ts";

export const SAMPLE_GROUNDWORK = path.join(import.meta.dirname, "..", "fixtures", "frontdoor-course", "groundwork");

/** A small invented course file, as the converter writes it: two stages, three Legs. */
export function sampleCourse(): CourseFile {
	return {
		format: COURSE_FORMAT,
		version: COURSE_VERSION,
		id: "sample-course",
		title: "Sample ground school",
		stages: [
			{
				id: "solo",
				title: "Before you solo",
				subjects: [
					{
						id: "paper-planes",
						title: "Paper planes",
						legs: [
							{ id: "folding-the-dart", title: "Folding the dart", outcome: "Fold a dart that flies straight.", acs: ["ZZ.I.A.K1", "ZZ.I.B.K1, K2"], keyPoints: ["Which paper to use", "The center fold"] },
							{ id: "throwing-level", title: "Throwing level", outcome: "Throw the dart level and let it glide.", acs: [], keyPoints: ["Grip", "Release"] },
						],
					},
				],
			},
			{
				id: "checkride",
				title: "Checkride prep",
				subjects: [
					{
						id: "kite-flying",
						title: "Kite flying",
						legs: [{ id: "line-tension", title: "Line tension", outcome: "Keep the line tight as the wind drops.", acs: ["ZZ.III.A.K1"], keyPoints: ["Pulling in line"] }],
					},
				],
			},
		],
	};
}

export const sampleCourseBytes = () => Buffer.from(JSON.stringify(sampleCourse(), null, 2));
