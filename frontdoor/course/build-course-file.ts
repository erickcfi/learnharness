/**
 * Makes the course file (file.ts) from Erick's course design in Groundwork
 * (master, 2026-11-11). Run it on a machine that has Groundwork; never commit
 * what it writes (the repo is public, the curriculum is not).
 *
 *   node frontdoor/course/build-course-file.ts <groundwork folder> <output file>
 *
 * Then upload the output on /admin/library, area "Course".
 *
 * It reads, from Groundwork:
 *  - scripts/courses/private-pilot.subjects.json: the subjects, in order
 *  - src/content/course/index.json: each subject's Legs, with title,
 *    outcome, stage ("when") and Point ids
 *  - scripts/courses/legs/<subject>.json: each Point's short label
 *  - src/content/course/subjects/<subject>.json: each Point's ACS codes
 *    (only the `id` and `acs` fields are read)
 *
 * It writes ids, stages, subjects, Legs, and for each Leg its title,
 * outcome, ACS codes and key point labels. Nothing else: no key point
 * statements, source passages or quizzes. The result is checked with the
 * same check the upload runs before it is written.
 *
 * Runnable by plain Node 26 (type stripping): relative imports with .ts
 * extensions, no TypeScript-only runtime syntax.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { COURSE_FORMAT, COURSE_VERSION, type CourseFile, type CourseLeg, type CourseStage, courseCounts, parseCourseFile } from "./file.ts";

/** Groundwork's three stages (src/lib/course/catalog.ts), in order. The ids are its `when` values. */
export const STAGES: ReadonlyArray<{ id: string; title: string }> = [
	{ id: "solo", title: "Before you solo" },
	{ id: "cross-country", title: "Before cross-country" },
	{ id: "checkride", title: "Checkride prep" },
];

export const COURSE_TITLE = "Private pilot ground school";

type Json = Record<string, unknown>;

function readJson(file: string): unknown {
	try {
		return JSON.parse(fs.readFileSync(file, "utf8"));
	} catch (error) {
		throw new Error(`Could not read ${file}: ${(error as Error).message}`);
	}
}

const isRecord = (v: unknown): v is Json => v !== null && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown, what: string): string => {
	if (typeof v !== "string" || !v.trim()) throw new Error(`${what} is missing`);
	return v.trim();
};
const arr = (v: unknown, what: string): unknown[] => {
	if (!Array.isArray(v)) throw new Error(`${what} is not a list`);
	return v;
};

/** "PA.I.A.K1; PA.I.A.R2" -> ["PA.I.A.K1", "PA.I.A.R2"]. Commas stay: some codes hold them ("PA.I.F.K3, K2e"). */
export function splitAcs(raw: unknown): string[] {
	if (typeof raw !== "string") return [];
	return raw
		.split(";")
		.map((code) => code.trim())
		.filter(Boolean);
}

/** Build the course from a Groundwork folder. Throws, naming the problem, when the data is incomplete. */
export function buildCourse(groundworkDir: string): CourseFile {
	const order = arr(readJson(path.join(groundworkDir, "scripts", "courses", "private-pilot.subjects.json")), "private-pilot.subjects.json").map((s, i) =>
		str(isRecord(s) ? s.id : undefined, `private-pilot.subjects.json entry ${i} id`),
	);
	const index = readJson(path.join(groundworkDir, "src", "content", "course", "index.json"));
	if (!isRecord(index)) throw new Error("index.json is not an object");
	const indexSubjects = arr(index.subjects, "index.json subjects").filter(isRecord);
	const byId = new Map(indexSubjects.map((s) => [str(s.id, "a subject id in index.json"), s]));
	for (const id of byId.keys()) if (!order.includes(id)) throw new Error(`The subject ${id} is in index.json but not in private-pilot.subjects.json`);

	const stages: CourseStage[] = STAGES.map((s) => ({ id: s.id, title: s.title, subjects: [] }));
	for (const subjectId of order) {
		const subject = byId.get(subjectId);
		if (!subject) throw new Error(`The subject ${subjectId} is in private-pilot.subjects.json but not in index.json`);
		const design = readJson(path.join(groundworkDir, "scripts", "courses", "legs", `${subjectId}.json`));
		const labels = isRecord(design) && isRecord(design.labels) ? design.labels : {};
		const data = readJson(path.join(groundworkDir, "src", "content", "course", "subjects", `${subjectId}.json`));
		const acsByPoint = new Map<string, string[]>();
		for (const p of isRecord(data) ? arr(data.points, `subjects/${subjectId}.json points`) : []) {
			if (isRecord(p) && typeof p.id === "string") acsByPoint.set(p.id, splitAcs(p.acs));
		}

		const title = str(subject.title, `the title of ${subjectId}`);
		for (const rawLeg of arr(subject.legs, `the Legs of ${subjectId}`)) {
			if (!isRecord(rawLeg)) throw new Error(`A Leg of ${subjectId} is not an object`);
			const legId = str(rawLeg.id, `a Leg id in ${subjectId}`);
			const stage = stages.find((s) => s.id === rawLeg.when);
			if (!stage) throw new Error(`The Leg ${legId} has no known stage (when: ${String(rawLeg.when)})`);
			const keyPoints: string[] = [];
			const acs: string[] = [];
			for (const pointId of arr(rawLeg.points, `the Points of ${legId}`)) {
				const label = typeof pointId === "string" ? labels[pointId] : undefined;
				keyPoints.push(str(label, `The label of Point ${String(pointId)} (Leg ${legId})`));
				for (const code of acsByPoint.get(String(pointId)) ?? []) if (!acs.includes(code)) acs.push(code);
			}
			const leg: CourseLeg = { id: legId, title: str(rawLeg.title, `the title of ${legId}`), outcome: str(rawLeg.outcome, `the outcome of ${legId}`), acs, keyPoints };
			let entry = stage.subjects.find((s) => s.id === subjectId);
			if (!entry) {
				entry = { id: subjectId, title, legs: [] };
				stage.subjects.push(entry);
			}
			entry.legs.push(leg);
		}
	}

	const course = {
		format: COURSE_FORMAT,
		version: COURSE_VERSION,
		id: str(index.id, "index.json id"),
		title: COURSE_TITLE,
		stages: stages.filter((s) => s.subjects.length > 0),
	};
	const checked = parseCourseFile(course);
	if (!checked.ok) throw new Error(`The built course does not pass the course file check: ${checked.error}`);
	return checked.course;
}

/** Build and write the file. Returns its size and counts. */
export function writeCourseFile(groundworkDir: string, outFile: string): { bytes: number; stages: number; subjects: number; legs: number } {
	const course = buildCourse(groundworkDir);
	const json = `${JSON.stringify(course, null, 2)}\n`;
	fs.mkdirSync(path.dirname(outFile), { recursive: true });
	fs.writeFileSync(outFile, json);
	return { bytes: Buffer.byteLength(json), ...courseCounts(course) };
}

const invokedDirectly = process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
	const [groundwork, out] = process.argv.slice(2);
	if (!groundwork || !out) {
		console.error("Usage: node frontdoor/course/build-course-file.ts <groundwork folder> <output file>");
		process.exit(2);
	}
	try {
		const r = writeCourseFile(path.resolve(groundwork), path.resolve(out));
		console.log(`Wrote ${out}: ${r.bytes} bytes, ${r.stages} stages, ${r.subjects} subjects, ${r.legs} Legs.`);
	} catch (error) {
		console.error((error as Error).message);
		process.exit(1);
	}
}
