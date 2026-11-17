/**
 * Makes the course file (file.ts) from North Aero's private lesson outline
 * (docs/decisions/2026-11-17-course-outline.md). Run it on a machine that
 * has the outline; never commit what it reads or writes (the repo is public,
 * the outline is not).
 *
 *   node frontdoor/course/build-course-file.ts <outline.json> <acs.json> <regs.json> <out.json>
 *
 * Then upload the output on /admin/library, area "Course".
 *
 * Inputs:
 *  - outline.json: the lessons in order, each { lesson, stage, group, title,
 *    codes, minutes: [min, max], milestone } and, for a lesson on rules the
 *    ACS does not cover, regs (for example "14 CFR 61.87(b), (c)"). An
 *    optional id keeps a lesson's id when lessons are renumbered; without
 *    it the id is "l" and the number (l05).
 *  - acs.json: the ACS elements, each { area, areaName, task, taskName,
 *    code, type, text }, in ACS order, with the FAA's wording.
 *  - regs.json: { source, headings: { "14 CFR 61.87": "...", "14 CFR
 *    61.87(b)": "..." } }, the eCFR headings, verbatim.
 *
 * It joins each lesson's codes with the FAA text, grouped by Task, in ACS
 * order. When a lesson has sub-elements (K1c) but not their parent line
 * (K1, covered by an earlier lesson), the parent line comes first, marked
 * context, so the sub-elements read right. It stops, naming the problem,
 * when a code is not in the ACS data, a lesson has no scope, a heading is
 * missing, or the lessons are out of order. The result goes through the
 * same check as the upload before it is written. The milestone is not
 * carried over.
 *
 * Runnable by plain Node 26 (type stripping): relative imports with .ts
 * extensions, no TypeScript-only runtime syntax.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
	type AcsElement,
	type AcsTask,
	allLessons,
	COURSE_FORMAT,
	COURSE_VERSION,
	type CourseFile,
	type CourseLesson,
	type CourseStage,
	courseCounts,
	parentCode,
	parseCourseFile,
	type RegSection,
} from "./file.ts";
import { firstMessage, startUrlBytes } from "./first-message.ts";

export const COURSE_ID = "private-pilot";
export const COURSE_TITLE = "Private pilot ground school";

type Json = Record<string, unknown>;

interface AcsRow {
	index: number;
	task: string;
	taskName: string;
	code: string;
	type: "K" | "R";
	text: string;
}

const OUTLINE_KEYS = ["lesson", "id", "stage", "group", "title", "codes", "minutes", "milestone", "regs"];

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

/** The ACS elements by code, with their place in ACS order. */
export function readAcs(value: unknown): Map<string, AcsRow> {
	const rows = new Map<string, AcsRow>();
	arr(value, "The ACS data").forEach((raw, index) => {
		if (!isRecord(raw)) throw new Error(`ACS entry ${index} is not an object`);
		const code = str(raw.code, `The code of ACS entry ${index}`);
		const task = code.split(".").slice(0, 3).join(".");
		const expected = `${code.split(".")[0]}.${str(raw.area, `The area of ${code}`)}.${str(raw.task, `The task of ${code}`)}`;
		if (task !== expected) throw new Error(`The ACS entry ${code} says area ${String(raw.area)}, task ${String(raw.task)}`);
		if (raw.type !== "K" && raw.type !== "R") throw new Error(`The ACS entry ${code} has type ${String(raw.type)}, not K or R`);
		if (rows.has(code)) throw new Error(`The ACS data lists ${code} twice`);
		rows.set(code, { index, task, taskName: str(raw.taskName, `The task name of ${code}`), code, type: raw.type, text: str(raw.text, `The text of ${code}`) });
	});
	return rows;
}

/** regs.json: { source, headings: { cite: heading } }. */
export function readRegHeadings(value: unknown): Map<string, string> {
	if (!isRecord(value) || !isRecord(value.headings)) throw new Error("regs.json must be { source, headings: { cite: heading } }");
	for (const key of Object.keys(value)) if (key !== "source" && key !== "headings") throw new Error(`regs.json has a field it does not use: ${key}`);
	return new Map(Object.entries(value.headings).map(([cite, heading]) => [cite, str(heading, `The heading of ${cite} in regs.json`)]));
}

/** "14 CFR 61.87(b), (c)" -> { section: "14 CFR 61.87", paragraphs: ["(b)", "(c)"] }. No paragraphs: the whole section. */
export function splitRegCite(raw: string): { section: string; paragraphs: string[] } {
	const m = /^(\d{1,2} CFR \d{1,3}\.\d{1,4}[a-z]?)\s*(.*)$/.exec(raw.trim());
	if (!m) throw new Error(`"${raw}" is not a citation like 14 CFR 61.87(b), (c)`);
	const rest = (m[2] ?? "").trim();
	const paragraphs = rest ? rest.split(",").map((p) => p.trim()) : [];
	for (const p of paragraphs) if (!/^(\([a-z0-9]{1,4}\))+$/.test(p)) throw new Error(`"${raw}" has a paragraph that is not like (b): ${p}`);
	return { section: m[1] ?? "", paragraphs };
}

function acsScope(codes: readonly string[], acs: Map<string, AcsRow>, where: string): AcsTask[] {
	const picked = new Map<string, { row: AcsRow; context: boolean }>();
	for (const code of codes) {
		const row = acs.get(code);
		if (!row) throw new Error(`${where}: the code ${code} is not in the ACS data`);
		if (picked.has(code)) throw new Error(`${where} lists ${code} twice`);
		picked.set(code, { row, context: false });
	}
	for (const code of codes) {
		const parent = parentCode(code);
		if (!parent || picked.has(parent)) continue;
		const row = acs.get(parent);
		if (!row) throw new Error(`${where}: the parent line ${parent} of ${code} is not in the ACS data`);
		picked.set(parent, { row, context: true });
	}
	const tasks: AcsTask[] = [];
	// Tasks in the order the lesson first names them; elements in ACS order.
	for (const code of codes) {
		const row = acs.get(code);
		if (!row || tasks.some((t) => t.task === row.task)) continue;
		const elements: AcsElement[] = [...picked.values()]
			.filter((p) => p.row.task === row.task)
			.sort((a, b) => a.row.index - b.row.index)
			.map(({ row: r, context }) => ({ code: r.code, type: r.type, text: r.text, sub: parentCode(r.code) !== null, ...(context ? { context: true as const } : {}) }));
		tasks.push({ task: row.task, name: row.taskName, elements });
	}
	return tasks;
}

function regScope(raw: unknown, headings: Map<string, string>, where: string): RegSection[] {
	const sections: RegSection[] = [];
	for (const item of arr(raw, `${where} regs`)) {
		const { section, paragraphs } = splitRegCite(str(item, `${where}: a regs entry`));
		const heading = headings.get(section);
		if (!heading) throw new Error(`${where}: regs.json has no heading for ${section}`);
		if (sections.some((s) => s.cite === section)) throw new Error(`${where} names ${section} twice`);
		sections.push({
			cite: section,
			heading,
			paragraphs: paragraphs.map((p) => {
				const cite = `${section}${p}`;
				const h = headings.get(cite);
				if (!h) throw new Error(`${where}: regs.json has no heading for ${cite}`);
				return { cite, heading: h };
			}),
		});
	}
	return sections;
}

/** Build the course from the three inputs (already parsed). Throws, naming the problem, when the data is incomplete. */
export function buildCourse(outline: unknown, acsData: unknown, regsData: unknown): CourseFile {
	const acs = readAcs(acsData);
	const headings = readRegHeadings(regsData);
	const stages: CourseStage[] = [];
	const closedGroups = new Set<string>();
	let current: { stage: string; group: string } | null = null;
	arr(outline, "The outline").forEach((raw, i) => {
		if (!isRecord(raw)) throw new Error(`Outline entry ${i} is not an object`);
		const where = `Lesson ${String(raw.lesson ?? i + 1)}`;
		for (const key of Object.keys(raw)) if (!OUTLINE_KEYS.includes(key)) throw new Error(`${where} has a field the converter does not know: ${key}`);
		if (raw.lesson !== i + 1) throw new Error(`Outline entry ${i} is lesson ${String(raw.lesson)}; the lessons must be numbered 1, 2, 3... in order`);
		const stageTitle = str(raw.stage, `${where}: the stage`);
		const groupTitle = str(raw.group, `${where}: the group`);
		const minutes = arr(raw.minutes, `${where}: minutes`);
		if (minutes.length !== 2 || !minutes.every((m) => typeof m === "number")) throw new Error(`${where}: minutes must be [shortest, longest]`);
		const lesson: CourseLesson = {
			id: raw.id === undefined ? `l${String(i + 1).padStart(2, "0")}` : str(raw.id, `${where}: the id`),
			number: i + 1,
			title: str(raw.title, `${where}: the title`),
			// Checked as whole minutes, shortest first, by the course file check below.
			minutes: [Number(minutes[0]), Number(minutes[1])],
			acs: acsScope(arr(raw.codes ?? [], `${where} codes`).map((c) => str(c, `${where}: a code`)), acs, where),
			regs: raw.regs === undefined ? [] : regScope(raw.regs, headings, where),
		};
		if (lesson.acs.length === 0 && lesson.regs.length === 0) throw new Error(`${where} has no scope: no ACS codes and no regs`);

		const key = `${stageTitle}\n${groupTitle}`;
		if (!current || current.stage !== stageTitle || current.group !== groupTitle) {
			if (current) closedGroups.add(`${current.stage}\n${current.group}`);
			if (closedGroups.has(key)) throw new Error(`${where}: the group "${groupTitle}" (${stageTitle}) comes back after other lessons; keep each group's lessons together`);
			let stage = stages.at(-1);
			if (!stage || stage.title !== stageTitle) {
				if (stages.some((s) => s.title === stageTitle)) throw new Error(`${where}: the stage "${stageTitle}" comes back after other stages; keep each stage's lessons together`);
				stage = { title: stageTitle, groups: [] };
				stages.push(stage);
			}
			stage.groups.push({ title: groupTitle, lessons: [] });
			current = { stage: stageTitle, group: groupTitle };
		}
		stages.at(-1)?.groups.at(-1)?.lessons.push(lesson);
	});

	const checked = parseCourseFile({ format: COURSE_FORMAT, version: COURSE_VERSION, id: COURSE_ID, title: COURSE_TITLE, stages });
	if (!checked.ok) throw new Error(`The built course does not pass the course file check: ${checked.error}`);
	return checked.course;
}

export interface BuildReport {
	bytes: number;
	stages: number;
	groups: number;
	lessons: number;
	acsElements: number;
	contextLines: number;
	regParagraphs: number;
	/** The lesson with the longest first message, its length in characters, and its chat address in bytes. */
	longest: { lesson: number; chars: number; urlBytes: number };
}

/** Build and write the file. Returns its size and counts. */
export function writeCourseFile(outlineFile: string, acsFile: string, regsFile: string, outFile: string): BuildReport {
	const course = buildCourse(readJson(outlineFile), readJson(acsFile), readJson(regsFile));
	const json = `${JSON.stringify(course, null, 2)}\n`;
	fs.mkdirSync(path.dirname(outFile), { recursive: true });
	fs.writeFileSync(outFile, json);
	let longest = { lesson: 0, chars: 0, urlBytes: 0 };
	for (const found of allLessons(course)) {
		const message = firstMessage(found);
		if (message.length > longest.chars) longest = { lesson: found.lesson.number, chars: message.length, urlBytes: startUrlBytes(message) };
	}
	return { bytes: Buffer.byteLength(json), ...courseCounts(course), longest };
}

const invokedDirectly = process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
	const [outline, acsFile, regs, out] = process.argv.slice(2);
	if (!outline || !acsFile || !regs || !out) {
		console.error("Usage: node frontdoor/course/build-course-file.ts <outline.json> <acs.json> <regs.json> <out.json>");
		process.exit(2);
	}
	try {
		const r = writeCourseFile(path.resolve(outline), path.resolve(acsFile), path.resolve(regs), path.resolve(out));
		console.log(
			`Wrote ${out}: ${r.bytes} bytes, ${r.stages} stages, ${r.groups} groups, ${r.lessons} lessons, ${r.acsElements} ACS elements (plus ${r.contextLines} parent lines for context), ${r.regParagraphs} regulation paragraphs.`,
		);
		console.log(`Longest first message: lesson ${r.longest.lesson}, ${r.longest.chars} characters, ${r.longest.urlBytes} bytes in the chat address.`);
	} catch (error) {
		console.error((error as Error).message);
		process.exit(1);
	}
}
