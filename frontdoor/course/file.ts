/**
 * The course file (docs/decisions/2026-11-17-course-outline.md): the one
 * lean JSON file the /course page reads. It holds North Aero's own private
 * pilot lesson outline: stages in order, each with groups in order, each
 * with numbered lessons. A lesson has a stable id, its number, title, an
 * estimate of tutor minutes, and its scope: ACS elements grouped by Task, in
 * the FAA's own words, and/or 14 CFR paragraphs with their headings.
 * Nothing else.
 *
 * The repo is public and the outline is not, so the real file is never
 * committed. build-course-file.ts makes it from the private outline, the
 * Owner uploads it to the library's "course" area (/admin/library), and the
 * front door reads it from <volume>/library/course/ at run time.
 *
 * The check is strict: a key the format does not name is refused, every
 * value is checked, and every lesson's first message must fit in the chat
 * address (first-message.ts). An older course file (version 1) is refused
 * with a plain message.
 *
 * Runnable by plain Node (type stripping): relative imports with .ts
 * extensions, no TypeScript-only runtime syntax.
 */
import { firstMessage, MAX_START_URL_BYTES, startUrlBytes } from "./first-message.ts";

export const COURSE_FORMAT = "northaero.course";
/** 2: the lesson outline (2026-11-17). 1 was the course design used before it. */
export const COURSE_VERSION = 2;
/** The library area and the one file name the course is stored under. */
export const COURSE_AREA = "course";
export const COURSE_FILE_NAME = "private-pilot.course.json";
/** The real file is about 200 KB. */
export const COURSE_MAX_BYTES = 5 * 1024 * 1024;

export type AcsType = "K" | "R";

/** One ACS line, in the FAA's own words. */
export interface AcsElement {
	/** The full code, for example PA.I.B.K1a. */
	code: string;
	/** K: knowledge. R: risk management. */
	type: AcsType;
	/** The FAA's wording, verbatim. */
	text: string;
	/** True for a sub-element (K1a) of a parent line (K1 "...including:"). */
	sub: boolean;
	/**
	 * Only on a parent line, and only when true: the lesson has some of its
	 * sub-elements but an earlier lesson covers the line itself. It is shown
	 * so the sub-elements read right.
	 */
	context?: true;
}

/** The ACS elements of one Task that a lesson covers. */
export interface AcsTask {
	/** The Task code, for example PA.I.B. */
	task: string;
	/** The Task name, for example Airworthiness Requirements. */
	name: string;
	/** In ACS order. A sub-element always comes after its parent line. */
	elements: AcsElement[];
}

export interface RegParagraph {
	/** For example 14 CFR 61.87(b). */
	cite: string;
	/** The eCFR heading, verbatim, or a plain description when the paragraph has none. */
	heading: string;
}

/** One 14 CFR section and the paragraphs of it a lesson covers (none: the whole section). */
export interface RegSection {
	/** For example 14 CFR 61.87. */
	cite: string;
	heading: string;
	paragraphs: RegParagraph[];
}

export interface CourseLesson {
	/** Stable id, for example l05. Sent by the Start form and stored with each start; never shown. */
	id: string;
	/** 1, 2, 3... in course order. */
	number: number;
	title: string;
	/** An estimate of tutor time: [shortest, longest]. */
	minutes: [number, number];
	acs: AcsTask[];
	regs: RegSection[];
}

export interface CourseGroup {
	title: string;
	lessons: CourseLesson[];
}

/** A stage's number is its place in the list (Stage 1, 2, 3). */
export interface CourseStage {
	title: string;
	groups: CourseGroup[];
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
/** PA.I.B: two capital letters, an Area of Operation in Roman numerals, a Task letter. */
const TASK = /^[A-Z]{2}\.[IVXL]{1,6}\.[A-Z]$/;
/** K1, R2, K1a after the Task code. */
const ELEMENT = /^([KR])(\d{1,2})([a-z]?)$/;
/** 14 CFR 61.87 */
const SECTION = /^\d{1,2} CFR \d{1,3}\.\d{1,4}[a-z]?$/;
/** (b), (b)(1) after the section. */
const PARAGRAPH = /^(\([a-z0-9]{1,4}\))+$/;
const MAX_TITLE = 200;
const MAX_TEXT = 600;
const MAX_MINUTES = 600;
const MAX_STAGES = 10;
const MAX_GROUPS = 100;
const MAX_LESSONS = 1000;
const MAX_TASKS = 20;
const MAX_ELEMENTS = 100;
const MAX_SECTIONS = 20;
const MAX_PARAGRAPHS = 40;

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
	if (/[\u0000-\u001f\u007f]/.test(out)) fail(`${where} has a control character`);
	return out;
}

function id(value: unknown, where: string): string {
	if (typeof value !== "string" || !ID.test(value)) fail(`${where} must be lowercase letters, digits and dashes`);
	return value;
}

function whole(value: unknown, where: string, min: number, max: number): number {
	if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) fail(`${where} must be a whole number from ${min} to ${max}`);
	return value;
}

function list<T>(value: unknown, where: string, min: number, max: number, each: (item: unknown, at: string) => T): T[] {
	if (!Array.isArray(value)) fail(`${where} must be a list`);
	if (value.length < min) fail(`${where} needs at least ${min}`);
	if (value.length > max) fail(`${where} has more than ${max}`);
	return value.map((item, i) => each(item, `${where}[${i}]`));
}

function unique(values: readonly string[], what: (value: string) => string): void {
	const seen = new Set<string>();
	for (const value of values) {
		if (seen.has(value)) fail(what(value));
		seen.add(value);
	}
}

/** "PA.I.B.K1a" -> "PA.I.B.K1"; null for a line that is not a sub-element. */
export function parentCode(code: string): string | null {
	return /\.[KR]\d{1,2}[a-z]$/.test(code) ? code.slice(0, -1) : null;
}

function parseElement(value: unknown, where: string, task: string): AcsElement {
	const o = record(value, where, ["code", "type", "text", "sub", "context"]);
	const code = text(o.code, `${where}.code`, 40);
	const m = code.startsWith(`${task}.`) ? ELEMENT.exec(code.slice(task.length + 1)) : null;
	if (!m) fail(`${where}.code must be a K or R element of ${task}, like ${task}.K1 or ${task}.K1a`);
	if (o.type !== "K" && o.type !== "R") fail(`${where}.type must be "K" or "R"`);
	if (o.type !== m[1]) fail(`${where}.type does not match the code ${code}`);
	if (typeof o.sub !== "boolean") fail(`${where}.sub must be true or false`);
	if (o.sub !== Boolean(m[3])) fail(`${where}.sub must be ${Boolean(m[3])} for ${code}`);
	const element: AcsElement = { code, type: o.type, text: text(o.text, `${where}.text`, MAX_TEXT), sub: o.sub };
	if (o.context !== undefined) {
		if (o.context !== true) fail(`${where}.context may only be true`);
		if (o.sub) fail(`${where}.context is for a parent line, not a sub-element`);
		element.context = true;
	}
	return element;
}

function parseTask(value: unknown, where: string): AcsTask {
	const o = record(value, where, ["task", "name", "elements"]);
	if (typeof o.task !== "string" || !TASK.test(o.task)) fail(`${where}.task must be a Task code like PA.I.B`);
	const task = o.task;
	const elements = list(o.elements, `${where}.elements`, 1, MAX_ELEMENTS, (v, at) => parseElement(v, at, task));
	unique(
		elements.map((e) => e.code),
		(code) => `${where} lists ${code} twice`,
	);
	elements.forEach((e, i) => {
		const parent = parentCode(e.code);
		if (parent && !elements.slice(0, i).some((p) => p.code === parent)) fail(`${where} has the sub-element ${e.code} without its parent line ${parent} before it`);
		if (e.context && !elements.slice(i + 1).some((s) => parentCode(s.code) === e.code)) fail(`${where} has the context line ${e.code} without any of its sub-elements after it`);
	});
	return { task, name: text(o.name, `${where}.name`, MAX_TITLE), elements };
}

function parseParagraph(value: unknown, where: string, section: string): RegParagraph {
	const o = record(value, where, ["cite", "heading"]);
	const cite = text(o.cite, `${where}.cite`, 60);
	if (!cite.startsWith(section) || !PARAGRAPH.test(cite.slice(section.length))) fail(`${where}.cite must be a paragraph of ${section}, like ${section}(a)`);
	return { cite, heading: text(o.heading, `${where}.heading`, MAX_TEXT) };
}

function parseSection(value: unknown, where: string): RegSection {
	const o = record(value, where, ["cite", "heading", "paragraphs"]);
	const cite = text(o.cite, `${where}.cite`, 40);
	if (!SECTION.test(cite)) fail(`${where}.cite must be a section like 14 CFR 61.87`);
	const paragraphs = list(o.paragraphs, `${where}.paragraphs`, 0, MAX_PARAGRAPHS, (v, at) => parseParagraph(v, at, cite));
	unique(
		paragraphs.map((p) => p.cite),
		(c) => `${where} lists ${c} twice`,
	);
	return { cite, heading: text(o.heading, `${where}.heading`, MAX_TEXT), paragraphs };
}

function parseMinutes(value: unknown, where: string): [number, number] {
	if (!Array.isArray(value) || value.length !== 2) fail(`${where} must be two numbers of minutes: [shortest, longest]`);
	const shortest = whole(value[0], `${where}[0]`, 1, MAX_MINUTES);
	const longest = whole(value[1], `${where}[1]`, 1, MAX_MINUTES);
	if (shortest > longest) fail(`${where} must have the shortest time first`);
	return [shortest, longest];
}

function parseLesson(value: unknown, where: string): CourseLesson {
	const o = record(value, where, ["id", "number", "title", "minutes", "acs", "regs"]);
	const lesson: CourseLesson = {
		id: id(o.id, `${where}.id`),
		number: whole(o.number, `${where}.number`, 1, MAX_LESSONS),
		title: text(o.title, `${where}.title`, MAX_TITLE),
		minutes: parseMinutes(o.minutes, `${where}.minutes`),
		acs: list(o.acs, `${where}.acs`, 0, MAX_TASKS, parseTask),
		regs: list(o.regs, `${where}.regs`, 0, MAX_SECTIONS, parseSection),
	};
	if (lesson.acs.length + lesson.regs.length === 0) fail(`${where} has no scope: it needs ACS elements or regulations`);
	unique(
		lesson.acs.map((t) => t.task),
		(t) => `${where} lists the Task ${t} twice`,
	);
	unique(
		lesson.regs.map((s) => s.cite),
		(c) => `${where} lists ${c} twice`,
	);
	return lesson;
}

function parseGroup(value: unknown, where: string): CourseGroup {
	const o = record(value, where, ["title", "lessons"]);
	return { title: text(o.title, `${where}.title`, MAX_TITLE), lessons: list(o.lessons, `${where}.lessons`, 1, MAX_LESSONS, parseLesson) };
}

function parseStage(value: unknown, where: string): CourseStage {
	const o = record(value, where, ["title", "groups"]);
	return { title: text(o.title, `${where}.title`, MAX_TITLE), groups: list(o.groups, `${where}.groups`, 1, MAX_GROUPS, parseGroup) };
}

/** Check a parsed course file. Returns the cleaned course, or the first problem in plain words. */
export function parseCourseFile(value: unknown): CourseParse {
	try {
		if (value === null || typeof value !== "object" || Array.isArray(value)) fail("The course file must be an object");
		const raw = value as Record<string, unknown>;
		if (raw.format !== COURSE_FORMAT) fail(`format must be "${COURSE_FORMAT}"`);
		if (raw.version === 1) fail("this is the old course file (version 1, from before the lesson outline). Make a new one with build-course-file.ts");
		if (raw.version !== COURSE_VERSION) fail(`version must be ${COURSE_VERSION}`);
		const o = record(value, "The course file", ["format", "version", "id", "title", "stages"]);
		const course: CourseFile = {
			format: COURSE_FORMAT,
			version: COURSE_VERSION,
			id: id(o.id, "id"),
			title: text(o.title, "title", MAX_TITLE),
			stages: list(o.stages, "stages", 1, MAX_STAGES, parseStage),
		};
		const found = allLessons(course);
		if (found.length > MAX_LESSONS) fail(`the course has more than ${MAX_LESSONS} lessons`);
		unique(
			found.map((f) => f.lesson.id),
			(lessonId) => `the lesson id ${lessonId} is used twice`,
		);
		found.forEach((f, i) => {
			if (f.lesson.number !== i + 1) fail(`lesson ${f.lesson.id} is number ${f.lesson.number}, but lessons must be numbered 1, 2, 3... in order (it should be ${i + 1})`);
			const bytes = startUrlBytes(firstMessage(f));
			if (bytes > MAX_START_URL_BYTES) fail(`lesson ${f.lesson.number}'s first message is too long for the chat address (${bytes} bytes, at most ${MAX_START_URL_BYTES})`);
		});
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

export interface FoundLesson {
	stage: CourseStage;
	/** 1, 2, 3: the stage's place in the course. */
	stageNumber: number;
	group: CourseGroup;
	lesson: CourseLesson;
}

/** Every lesson in course order, with its stage and group. */
export function allLessons(course: CourseFile): FoundLesson[] {
	return course.stages.flatMap((stage, i) => stage.groups.flatMap((group) => group.lessons.map((lesson) => ({ stage, stageNumber: i + 1, group, lesson }))));
}

/** One lesson by id, with its stage and group, or null. */
export function findLesson(course: CourseFile, lessonId: unknown): FoundLesson | null {
	if (typeof lessonId !== "string" || !ID.test(lessonId)) return null;
	return allLessons(course).find((f) => f.lesson.id === lessonId) ?? null;
}

/** Counts for logs and the report. Context lines are counted apart from the ACS elements. */
export function courseCounts(course: CourseFile): { stages: number; groups: number; lessons: number; acsElements: number; contextLines: number; regParagraphs: number } {
	let groups = 0;
	let acsElements = 0;
	let contextLines = 0;
	let regParagraphs = 0;
	for (const stage of course.stages) groups += stage.groups.length;
	const lessons = allLessons(course);
	for (const { lesson } of lessons) {
		for (const task of lesson.acs) {
			for (const element of task.elements) {
				if (element.context) contextLines++;
				else acsElements++;
			}
		}
		for (const section of lesson.regs) regParagraphs += Math.max(1, section.paragraphs.length);
	}
	return { stages: course.stages.length, groups, lessons: lessons.length, acsElements, contextLines, regParagraphs };
}
