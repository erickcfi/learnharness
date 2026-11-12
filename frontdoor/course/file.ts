/**
 * The course file (master, 2026-11-11): the one lean JSON file the /course
 * page reads. It holds ids, stages, subjects, Legs, and for each Leg its
 * title, one-sentence outcome, ACS codes and key point labels. Nothing else.
 *
 * The repo is public and the curriculum is not, so the real file is never
 * committed. build-course-file.ts makes it from Groundwork's data, the Owner
 * uploads it to the library's "course" area (/admin/library), and the front
 * door reads it from <volume>/library/course/ at run time.
 *
 * The check is strict: a key the format does not name is refused. So a file
 * that carries key point statements, source passages or quizzes (under
 * review, not for students yet) cannot be uploaded by mistake.
 *
 * Framework-free and runnable by plain Node (type stripping): no imports,
 * no TypeScript-only runtime syntax.
 */

export const COURSE_FORMAT = "northaero.course";
export const COURSE_VERSION = 1;
/** The library area and the one file name the course is stored under. */
export const COURSE_AREA = "course";
export const COURSE_FILE_NAME = "private-pilot.course.json";
/** The real file is about 200 KB. */
export const COURSE_MAX_BYTES = 5 * 1024 * 1024;

export interface CourseLeg {
	id: string;
	title: string;
	/** What the student can do after the Leg, in one sentence. */
	outcome: string;
	/** FAA ACS codes (or regulations) the Leg covers, as the data writes them. */
	acs: string[];
	/** Short key point labels, safe to show before the student answers. Never the statements. */
	keyPoints: string[];
}

export interface CourseSubject {
	id: string;
	title: string;
	legs: CourseLeg[];
}

export interface CourseStage {
	id: string;
	title: string;
	subjects: CourseSubject[];
}

export interface CourseFile {
	format: typeof COURSE_FORMAT;
	version: typeof COURSE_VERSION;
	id: string;
	title: string;
	stages: CourseStage[];
}

export type CourseParse = { ok: true; course: CourseFile } | { ok: false; error: string };

const ID = /^[a-z0-9][a-z0-9-]{0,79}$/;
const MAX_TITLE = 200;
const MAX_OUTCOME = 400;
const MAX_ACS = 40;
const MAX_ACS_CODE = 80;
const MAX_KEY_POINTS = 12;
const MAX_KEY_POINT = 120;
const MAX_LEGS = 2000;

class Invalid extends Error {}

function fail(message: string): never {
	throw new Invalid(message);
}

function record(value: unknown, where: string, keys: readonly string[]): Record<string, unknown> {
	if (value === null || typeof value !== "object" || Array.isArray(value)) fail(`${where} must be an object`);
	const obj = value as Record<string, unknown>;
	for (const key of Object.keys(obj)) if (!keys.includes(key)) fail(`${where} has a field the course file does not allow: ${key}`);
	return obj;
}

function text(value: unknown, where: string, max: number): string {
	if (typeof value !== "string") fail(`${where} must be text`);
	const out = value.trim();
	if (!out) fail(`${where} is empty`);
	if (out.length > max) fail(`${where} is longer than ${max} characters`);
	if (/[\u0000-\u0008\u000b-\u001f\u007f]/.test(out)) fail(`${where} has a control character`);
	return out;
}

function id(value: unknown, where: string): string {
	if (typeof value !== "string" || !ID.test(value)) fail(`${where} must be lowercase letters, digits and dashes`);
	return value;
}

function list<T>(value: unknown, where: string, min: number, max: number, each: (item: unknown, at: string) => T): T[] {
	if (!Array.isArray(value)) fail(`${where} must be a list`);
	if (value.length < min) fail(`${where} needs at least ${min}`);
	if (value.length > max) fail(`${where} has more than ${max}`);
	return value.map((item, i) => each(item, `${where}[${i}]`));
}

function parseLeg(value: unknown, where: string): CourseLeg {
	const o = record(value, where, ["id", "title", "outcome", "acs", "keyPoints"]);
	return {
		id: id(o.id, `${where}.id`),
		title: text(o.title, `${where}.title`, MAX_TITLE),
		outcome: text(o.outcome, `${where}.outcome`, MAX_OUTCOME),
		acs: list(o.acs, `${where}.acs`, 0, MAX_ACS, (v, at) => text(v, at, MAX_ACS_CODE)),
		keyPoints: list(o.keyPoints, `${where}.keyPoints`, 1, MAX_KEY_POINTS, (v, at) => text(v, at, MAX_KEY_POINT)),
	};
}

function parseSubject(value: unknown, where: string): CourseSubject {
	const o = record(value, where, ["id", "title", "legs"]);
	return {
		id: id(o.id, `${where}.id`),
		title: text(o.title, `${where}.title`, MAX_TITLE),
		legs: list(o.legs, `${where}.legs`, 1, MAX_LEGS, parseLeg),
	};
}

function parseStage(value: unknown, where: string): CourseStage {
	const o = record(value, where, ["id", "title", "subjects"]);
	const stage = {
		id: id(o.id, `${where}.id`),
		title: text(o.title, `${where}.title`, MAX_TITLE),
		subjects: list(o.subjects, `${where}.subjects`, 1, 200, parseSubject),
	};
	const seen = new Set<string>();
	for (const s of stage.subjects) {
		if (seen.has(s.id)) fail(`${where} lists the subject ${s.id} twice`);
		seen.add(s.id);
	}
	return stage;
}

/** Check a parsed course file. Returns the cleaned course, or the first problem in plain words. */
export function parseCourseFile(value: unknown): CourseParse {
	try {
		const o = record(value, "The course file", ["format", "version", "id", "title", "stages"]);
		if (o.format !== COURSE_FORMAT) fail(`format must be "${COURSE_FORMAT}"`);
		if (o.version !== COURSE_VERSION) fail(`version must be ${COURSE_VERSION}`);
		const course: CourseFile = {
			format: COURSE_FORMAT,
			version: COURSE_VERSION,
			id: id(o.id, "id"),
			title: text(o.title, "title", MAX_TITLE),
			stages: list(o.stages, "stages", 1, 20, parseStage),
		};
		const stageIds = new Set<string>();
		const legIds = new Set<string>();
		for (const stage of course.stages) {
			if (stageIds.has(stage.id)) fail(`the stage ${stage.id} is listed twice`);
			stageIds.add(stage.id);
			for (const subject of stage.subjects) {
				for (const leg of subject.legs) {
					if (legIds.has(leg.id)) fail(`the Leg id ${leg.id} is used twice`);
					legIds.add(leg.id);
				}
			}
		}
		if (legIds.size > MAX_LEGS) fail(`the course has more than ${MAX_LEGS} Legs`);
		return { ok: true, course };
	} catch (error) {
		if (error instanceof Invalid) return { ok: false, error: error.message };
		throw error;
	}
}

/** Parse the file's bytes (UTF-8 JSON, a byte-order mark allowed) and check it. */
export function parseCourseBytes(bytes: Uint8Array): CourseParse {
	let value: unknown;
	try {
		value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
	} catch {
		return { ok: false, error: "it is not JSON" };
	}
	return parseCourseFile(value);
}

export interface FoundLeg {
	stage: CourseStage;
	subject: CourseSubject;
	leg: CourseLeg;
}

/** One Leg by id, with its stage and subject, or null. */
export function findLeg(course: CourseFile, legId: unknown): FoundLeg | null {
	if (typeof legId !== "string" || !ID.test(legId)) return null;
	for (const stage of course.stages) {
		for (const subject of stage.subjects) {
			const leg = subject.legs.find((l) => l.id === legId);
			if (leg) return { stage, subject, leg };
		}
	}
	return null;
}

/** Counts for logs and the report. */
export function courseCounts(course: CourseFile): { stages: number; subjects: number; legs: number } {
	const subjects = new Set<string>();
	let legs = 0;
	for (const stage of course.stages) {
		for (const subject of stage.subjects) {
			subjects.add(subject.id);
			legs += subject.legs.length;
		}
	}
	return { stages: course.stages.length, subjects: subjects.size, legs };
}
