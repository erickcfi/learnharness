/**
 * The guided course (docs/decisions/2026-11-17-course-outline.md): the
 * course file check, the converter from the lesson outline, and a lesson's
 * first message. Every course here is invented (kites,
 * tests/fixtures/frontdoor-course/outline); the real outline never goes in
 * this repo.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import { buildCourse, COURSE_ID, COURSE_TITLE, splitRegCite, writeCourseFile } from "../frontdoor/course/build-course-file.ts";
import { allLessons, courseCounts, findLesson, parentCode, parseCourseBytes, parseCourseFile } from "../frontdoor/course/file.ts";
import { firstMessage, MAX_START_URL_BYTES, R_ONLY_LEAD, startUrlBytes, STUDENT_LINE } from "../frontdoor/course/first-message.ts";
import { oldCourseFile, SAMPLE_ACS, SAMPLE_OUTLINE, SAMPLE_REGS, sampleCourse } from "./helpers/frontdoor-course.ts";

const REPO = path.join(import.meta.dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lh-course-file-"));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const copy = <T>(v: T): T => structuredClone(v);
const readJson = (file: string): any => JSON.parse(fs.readFileSync(file, "utf8"));
const build = (outline = readJson(SAMPLE_OUTLINE), acs = readJson(SAMPLE_ACS), regs = readJson(SAMPLE_REGS)) => buildCourse(outline, acs, regs);
/** The sample course as plain JSON, to break on purpose. */
const raw = () => copy(sampleCourse()) as unknown as Record<string, any>;
const lessonOf = (c: Record<string, any>, stage: number, group: number, lesson: number) => c.stages[stage].groups[group].lessons[lesson];

describe("the course file check", () => {
	it("accepts the lean course file and counts it", () => {
		const r = parseCourseFile(sampleCourse());
		assert.ok(r.ok, r.ok ? "" : r.error);
		assert.deepEqual(r.course, sampleCourse());
		assert.deepEqual(courseCounts(r.course), { stages: 2, groups: 4, lessons: 5, acsElements: 14, contextLines: 1, regParagraphs: 3 });
		assert.deepEqual(
			allLessons(r.course).map((f) => [f.lesson.number, f.lesson.id, f.stageNumber, f.group.title]),
			[
				[1, "l01", 1, "Picking a kite"],
				[2, "l02", 1, "Picking a kite"],
				[3, "l03", 1, "The field"],
				[4, "l04", 2, "Kite rules"],
				[5, "l05", 2, "Launching"],
			],
		);
		assert.equal(findLesson(r.course, "l04")?.stage.title, "Flying");
		for (const bad of ["nope", "../etc", 42, undefined]) assert.equal(findLesson(r.course, bad), null);
		assert.equal(parentCode("PA.I.B.K1a"), "PA.I.B.K1");
		assert.equal(parentCode("PA.I.B.K10"), null);
	});

	it("refuses any field the format does not name", () => {
		const cases: Array<[string, (c: Record<string, any>) => void, string]> = [
			["an outcome on a lesson", (c) => (lessonOf(c, 0, 0, 0).outcome = "Fly a kite."), "outcome"],
			["key points on a lesson", (c) => (lessonOf(c, 0, 0, 0).keyPoints = ["Line"]), "keyPoints"],
			["a milestone on a lesson", (c) => (lessonOf(c, 0, 0, 0).milestone = "first-flight"), "milestone"],
			["subjects on a stage", (c) => (c.stages[0].subjects = []), "subjects"],
			["an id on a group", (c) => (c.stages[0].groups[0].id = "kites"), "id"],
			["a note on an element", (c) => (lessonOf(c, 0, 0, 0).acs[0].elements[0].note = "x"), "note"],
			["a summary on a regulation", (c) => (lessonOf(c, 1, 0, 0).regs[0].summary = "x"), "summary"],
			["a quiz on the course", (c) => (c.quizzes = []), "quizzes"],
		];
		for (const [what, change, field] of cases) {
			const c = raw();
			change(c);
			const r = parseCourseFile(c);
			assert.ok(!r.ok, what);
			assert.match(r.error, new RegExp(`does not allow: ${field}$`), what);
		}
	});

	it("refuses the earlier course file (version 1) with a plain message, and any other format or version", () => {
		const r = parseCourseFile(oldCourseFile());
		assert.ok(!r.ok);
		assert.equal(r.error, "this is the old course file (version 1, from before the lesson outline). Make a new one with build-course-file.ts");
		const wrongFormat = parseCourseFile({ ...sampleCourse(), format: "other" });
		assert.ok(!wrongFormat.ok && wrongFormat.error === 'format must be "northaero.course"');
		const wrongVersion = parseCourseFile({ ...sampleCourse(), version: 3 });
		assert.ok(!wrongVersion.ok && wrongVersion.error === "version must be 2");
		for (const v of [null, [], "x", 3]) assert.equal(parseCourseFile(v).ok, false);
	});

	it("refuses bad minutes", () => {
		for (const minutes of [[40, 25], [0, 10], [10.5, 20], [10], [10, 20, 30], "25-40", [10, 601], ["10", "20"], null]) {
			const c = raw();
			lessonOf(c, 0, 0, 0).minutes = minutes;
			const r = parseCourseFile(c);
			assert.ok(!r.ok, JSON.stringify(minutes));
			assert.match(r.error, /minutes/, JSON.stringify(minutes));
		}
		const same = raw();
		lessonOf(same, 0, 0, 0).minutes = [25, 25];
		assert.ok(parseCourseFile(same).ok, "the same shortest and longest time is fine");
	});

	it("refuses repeated lesson ids and lessons out of order", () => {
		const twice = raw();
		lessonOf(twice, 0, 0, 1).id = "l01";
		const r = parseCourseFile(twice);
		assert.ok(!r.ok && r.error === "the lesson id l01 is used twice");

		const gap = raw();
		lessonOf(gap, 0, 1, 0).number = 7;
		const g = parseCourseFile(gap);
		assert.ok(!g.ok && /lesson l03 is number 7, but lessons must be numbered 1, 2, 3\.\.\. in order \(it should be 3\)/.test(g.error));

		const swapped = raw();
		[lessonOf(swapped, 0, 0, 0).number, lessonOf(swapped, 0, 0, 1).number] = [2, 1];
		assert.equal(parseCourseFile(swapped).ok, false);
	});

	it("refuses bad values in a lesson's scope", () => {
		const element = (c: Record<string, any>, i: number) => lessonOf(c, 0, 0, 0).acs[0].elements[i];
		const bad: Array<[string, (c: Record<string, any>) => void, RegExp]> = [
			["no scope", (c) => (lessonOf(c, 0, 0, 0).acs = []), /has no scope/],
			["a Task code", (c) => (lessonOf(c, 0, 0, 0).acs[0].task = "ZZ.I"), /must be a Task code/],
			["an element of another Task", (c) => (element(c, 3).code = "ZZ.I.B.K2"), /must be a K or R element of ZZ\.I\.A/],
			["a skill element", (c) => (element(c, 3).code = "ZZ.I.A.S1"), /must be a K or R element/],
			["a type that does not match", (c) => (element(c, 3).type = "R"), /type does not match/],
			["an unknown type", (c) => (element(c, 3).type = "S"), /type must be "K" or "R"/],
			["sub on a parent line", (c) => (element(c, 0).sub = true), /sub must be false/],
			["sub not a boolean", (c) => (element(c, 1).sub = "yes"), /sub must be true or false/],
			["a sub-element without its parent", (c) => lessonOf(c, 0, 0, 0).acs[0].elements.splice(0, 1), /sub-element ZZ\.I\.A\.K1a without its parent line ZZ\.I\.A\.K1/],
			["a sub-element before its parent", (c) => lessonOf(c, 0, 0, 0).acs[0].elements.reverse(), /without its parent line/],
			["context on a sub-element", (c) => (element(c, 1).context = true), /context is for a parent line/],
			["context false", (c) => (element(c, 0).context = false), /context may only be true/],
			["context with no sub-element after it", (c) => (element(c, 3).context = true), /context line ZZ\.I\.A\.K2 without any of its sub-elements/],
			["an element twice", (c) => lessonOf(c, 0, 0, 0).acs[0].elements.push(copy(element(c, 3))), /lists ZZ\.I\.A\.K2 twice/],
			["a Task twice", (c) => lessonOf(c, 0, 0, 0).acs.push(copy(lessonOf(c, 0, 0, 0).acs[0])), /lists the Task ZZ\.I\.A twice/],
			["a long text", (c) => (element(c, 3).text = "x".repeat(601)), /longer than 600/],
			["a control character", (c) => (element(c, 3).text = "Line\nstrength"), /control character/],
			["a section cite", (c) => (lessonOf(c, 1, 0, 0).regs[0].cite = "Part 199"), /must be a section like 14 CFR 61\.87/],
			["a paragraph of another section", (c) => (lessonOf(c, 1, 0, 0).regs[0].paragraphs[0].cite = "14 CFR 199.6(a)"), /must be a paragraph of 14 CFR 199\.5/],
			["a section twice", (c) => lessonOf(c, 1, 0, 0).regs.push(copy(lessonOf(c, 1, 0, 0).regs[0])), /lists 14 CFR 199\.5 twice/],
			["an empty heading", (c) => (lessonOf(c, 1, 0, 0).regs[1].heading = " "), /heading is empty/],
			["a lesson id", (c) => (lessonOf(c, 0, 0, 0).id = "../x"), /lowercase letters, digits and dashes/],
			["an empty title", (c) => (lessonOf(c, 0, 0, 0).title = "  "), /title is empty/],
			["no stages", (c) => (c.stages = []), /stages needs at least 1/],
			["no groups", (c) => (c.stages[0].groups = []), /groups needs at least 1/],
			["no lessons", (c) => (c.stages[0].groups[0].lessons = []), /lessons needs at least 1/],
		];
		for (const [what, change, expected] of bad) {
			const c = raw();
			change(c);
			const r = parseCourseFile(c);
			assert.ok(!r.ok, what);
			assert.match(r.error, expected, what);
		}
	});

	it("refuses a lesson whose first message would not fit in the chat address", () => {
		const c = raw();
		const elements = Array.from({ length: 30 }, (_, i) => ({ code: `ZZ.I.A.K${i + 1}`, type: "K", text: `Kite fact ${i + 1}: ${"a long sentence about kites ".repeat(10)}`.trim(), sub: false }));
		lessonOf(c, 0, 0, 0).acs = [{ task: "ZZ.I.A", name: "Kite Selection", elements }];
		const r = parseCourseFile(c);
		assert.ok(!r.ok);
		assert.match(r.error, /^lesson 1's first message is too long for the chat address \(\d+ bytes, at most 6144\)$/);
	});

	it("reads bytes: JSON only, a byte-order mark allowed", () => {
		const json = JSON.stringify(sampleCourse());
		assert.ok(parseCourseBytes(Buffer.from(json)).ok);
		assert.ok(parseCourseBytes(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(json)])).ok);
		const r = parseCourseBytes(Buffer.from("%PDF-1.7"));
		assert.ok(!r.ok && r.error === "it is not JSON");
		assert.equal(parseCourseBytes(Buffer.from([0xff, 0xfe, 0x00])).ok, false);
	});

	it("trims text", () => {
		const c = raw();
		lessonOf(c, 0, 0, 0).title = "  Kite shapes and line ";
		const r = parseCourseFile(c);
		assert.ok(r.ok);
		assert.equal(r.course.stages[0]!.groups[0]!.lessons[0]!.title, "Kite shapes and line");
	});
});

describe("the converter (build-course-file.ts), on an invented outline", () => {
	it("joins the outline with the ACS text and the regulation headings, exactly as the sample course", () => {
		const course = build();
		assert.equal(course.id, COURSE_ID);
		assert.equal(course.title, COURSE_TITLE);
		assert.deepEqual(course, sampleCourse());
	});

	it("adds a parent line as context when a lesson has only some of its sub-elements, and keeps ACS order", () => {
		const course = build();
		assert.deepEqual(
			findLesson(course, "l02")!.lesson.acs[0]!.elements.map((e) => [e.code, e.context ?? false]),
			[
				["ZZ.I.A.K1", true],
				["ZZ.I.A.K1c", false],
				["ZZ.I.A.R1", false],
				["ZZ.I.A.R2", false],
				["ZZ.I.A.R2a", false],
				["ZZ.I.A.R2b", false],
			],
		);
		assert.deepEqual(
			findLesson(course, "l05")!.lesson.acs[0]!.elements.map((e) => e.code),
			["ZZ.II.A.K1", "ZZ.II.A.R1"],
			"the outline lists R1 first; the file keeps ACS order",
		);
	});

	it("turns a regs lesson into sections and paragraphs with their headings", () => {
		assert.deepEqual(findLesson(build(), "l04")!.lesson.regs, sampleCourse().stages[1]!.groups[0]!.lessons[0]!.regs);
		assert.deepEqual(splitRegCite("14 CFR 61.87(b), (c), (n)"), { section: "14 CFR 61.87", paragraphs: ["(b)", "(c)", "(n)"] });
		assert.deepEqual(splitRegCite("14 CFR 61.89(a)"), { section: "14 CFR 61.89", paragraphs: ["(a)"] });
		assert.deepEqual(splitRegCite("14 CFR 91.103"), { section: "14 CFR 91.103", paragraphs: [] });
		assert.throws(() => splitRegCite("Part 61"), /not a citation/);
		assert.throws(() => splitRegCite("14 CFR 61.87 b"), /paragraph that is not like \(b\)/);
	});

	it("writes a file that passes the upload check, with counts, size and the longest first message", () => {
		const out = path.join(tmp, "out", "sample.course.json");
		const r = writeCourseFile(SAMPLE_OUTLINE, SAMPLE_ACS, SAMPLE_REGS, out);
		const text = fs.readFileSync(out, "utf8");
		assert.equal(r.bytes, Buffer.byteLength(text));
		assert.deepEqual({ ...r, bytes: 0, longest: null }, { bytes: 0, stages: 2, groups: 4, lessons: 5, acsElements: 14, contextLines: 1, regParagraphs: 3, longest: null });
		const messages = allLessons(sampleCourse()).map((f) => ({ lesson: f.lesson.number, message: firstMessage(f) }));
		const longest = messages.reduce((a, b) => (b.message.length > a.message.length ? b : a));
		assert.deepEqual(r.longest, { lesson: longest.lesson, chars: longest.message.length, urlBytes: startUrlBytes(longest.message) });
		assert.ok(parseCourseBytes(fs.readFileSync(out)).ok, "what it writes passes the upload check");
		for (const left of ["milestone", "first-flight", "areaName", "Before Flying", "Landing the Kite", "Invented for the tests"]) assert.equal(text.includes(left), false, `the course file holds ${left}`);
	});

	it("stops, naming the problem, when a code is not in the ACS data", () => {
		const outline = readJson(SAMPLE_OUTLINE);
		outline[1].codes.push("ZZ.I.A.K9");
		assert.throws(() => build(outline), /^Error: Lesson 2: the code ZZ\.I\.A\.K9 is not in the ACS data$/);
		const orphan = readJson(SAMPLE_OUTLINE);
		const acs = readJson(SAMPLE_ACS).filter((e: { code: string }) => e.code !== "ZZ.I.A.K1");
		orphan[0].codes = ["ZZ.I.A.K1a"];
		assert.throws(() => build(orphan, acs), /Lesson 1: the parent line ZZ\.I\.A\.K1 of ZZ\.I\.A\.K1a is not in the ACS data/);
	});

	it("stops when a lesson has no scope, or a regulation has no heading", () => {
		const outline = readJson(SAMPLE_OUTLINE);
		outline[4].codes = [];
		assert.throws(() => build(outline), /Lesson 5 has no scope/);
		const regs = readJson(SAMPLE_REGS);
		delete regs.headings["14 CFR 199.5(b)"];
		assert.throws(() => build(undefined, undefined, regs), /Lesson 4: regs\.json has no heading for 14 CFR 199\.5\(b\)/);
		const noSection = readJson(SAMPLE_REGS);
		delete noSection.headings["14 CFR 199.7"];
		assert.throws(() => build(undefined, undefined, noSection), /regs\.json has no heading for 14 CFR 199\.7$/);
		assert.throws(() => build(undefined, undefined, { headings: {}, extra: 1 }), /regs\.json has a field it does not use: extra/);
	});

	it("stops when the lessons are out of order, a group comes back, or an entry has a field it does not know", () => {
		const numbered = readJson(SAMPLE_OUTLINE);
		numbered[2].lesson = 9;
		assert.throws(() => build(numbered), /lessons must be numbered 1, 2, 3\.\.\. in order/);
		const back = readJson(SAMPLE_OUTLINE);
		back[2].group = "Picking a kite";
		back[1].group = "The field";
		assert.throws(() => build(back), /the group "Picking a kite" \(Before the first flight\) comes back/);
		const stageBack = readJson(SAMPLE_OUTLINE);
		stageBack[4].stage = "Before the first flight";
		assert.throws(() => build(stageBack), /the stage "Before the first flight" comes back/);
		const unknown = readJson(SAMPLE_OUTLINE);
		unknown[0].outcome = "Fly a kite.";
		assert.throws(() => build(unknown), /Lesson 1 has a field the converter does not know: outcome/);
		const minutes = readJson(SAMPLE_OUTLINE);
		minutes[0].minutes = [30];
		assert.throws(() => build(minutes), /Lesson 1: minutes must be \[shortest, longest\]/);
		const backwards = readJson(SAMPLE_OUTLINE);
		backwards[0].minutes = [30, 20];
		assert.throws(() => build(backwards), /does not pass the course file check: .*shortest time first/);
	});

	it("keeps an id the outline gives, so a renumbered lesson keeps its Started marks", () => {
		const outline = readJson(SAMPLE_OUTLINE);
		outline[0].id = "kite-shapes";
		const course = build(outline);
		assert.equal(allLessons(course)[0]!.lesson.id, "kite-shapes");
		assert.equal(allLessons(course)[1]!.lesson.id, "l02");
	});

	it("runs from the command line with plain Node", () => {
		const out = path.join(tmp, "cli", "course.json");
		const run = spawnSync(process.execPath, [path.join(REPO, "frontdoor", "course", "build-course-file.ts"), SAMPLE_OUTLINE, SAMPLE_ACS, SAMPLE_REGS, out], { encoding: "utf8" });
		assert.equal(run.status, 0, run.stderr);
		assert.match(run.stdout, /2 stages, 4 groups, 5 lessons, 14 ACS elements \(plus 1 parent lines for context\), 3 regulation paragraphs\./);
		assert.match(run.stdout, /Longest first message: lesson \d, \d+ characters, \d+ bytes in the chat address\./);
		assert.ok(parseCourseBytes(fs.readFileSync(out)).ok);
		const usage = spawnSync(process.execPath, [path.join(REPO, "frontdoor", "course", "build-course-file.ts"), SAMPLE_OUTLINE], { encoding: "utf8" });
		assert.equal(usage.status, 2);
		const broken = path.join(tmp, "broken-outline.json");
		fs.writeFileSync(broken, JSON.stringify([{ lesson: 1, stage: "S", group: "G", title: "T", codes: ["ZZ.X.A.K1"], minutes: [10, 20] }]));
		const failed = spawnSync(process.execPath, [path.join(REPO, "frontdoor", "course", "build-course-file.ts"), broken, SAMPLE_ACS, SAMPLE_REGS, path.join(tmp, "never.json")], { encoding: "utf8" });
		assert.equal(failed.status, 1);
		assert.match(failed.stderr, /the code ZZ\.X\.A\.K1 is not in the ACS data/);
		assert.equal(fs.existsSync(path.join(tmp, "never.json")), false);
	});
});

describe("a lesson's first message", () => {
	const course = sampleCourse();
	const message = (id: string) => firstMessage(findLesson(course, id)!);
	const head = (n: number, title: string, stage: string) => [STUDENT_LINE, "", `Lesson ${n}: ${title}`, stage, ""];

	it("one Task, with a parent line and its sub-elements", () => {
		assert.equal(
			message("l01"),
			[
				...head(1, "Kite shapes and line", "Stage 1: Before the first flight"),
				"From the Private Pilot ACS (FAA-S-ACS-6C), Task I.A, Kite Selection. I should understand:",
				"- K1 Kite shapes and sizes, including:",
				"  - K1a Diamond kites",
				"  - K1b Box kites",
				"- K2 Line strength and weight.",
			].join("\n"),
		);
		assert.equal(STUDENT_LINE, "I am a student pilot working toward the FAA private pilot certificate. I would like to work on this lesson.");
	});

	it("risk lines, a context parent line, and a risk parent with sub-elements", () => {
		assert.equal(
			message("l02"),
			[
				...head(2, "Reels, gloves, and big kites", "Stage 1: Before the first flight"),
				"From the Private Pilot ACS (FAA-S-ACS-6C), Task I.A, Kite Selection. I should understand:",
				"- K1 Kite shapes and sizes, including:",
				"  - K1c Delta kites",
				"And be able to identify, assess, and mitigate risk associated with:",
				"- R1 Choosing a kite too large for the wind.",
				"- R2 Use and limitations of:",
				"  - R2a Reels",
				"  - R2b Gloves",
			].join("\n"),
		);
	});

	it("one block per Task when a lesson spans several Tasks", () => {
		assert.equal(
			message("l03"),
			[
				...head(3, "Where to fly", "Stage 1: Before the first flight"),
				"From the Private Pilot ACS (FAA-S-ACS-6C), Task I.B, Launch Site. I should understand:",
				"- K1 Power lines, trees, and other obstructions.",
				"And be able to identify, assess, and mitigate risk associated with:",
				"- R1 Launching near people or roads.",
				"",
				"From the Private Pilot ACS (FAA-S-ACS-6C), Task II.A, Launching. I should understand:",
				"- K2 The wind window.",
			].join("\n"),
		);
	});

	it("14 CFR paragraphs with their headings for a lesson the ACS does not cover", () => {
		assert.equal(
			message("l04"),
			[
				...head(4, "Kite rules near airports", "Stage 2: Flying"),
				"From 14 CFR Part 199 (the ACS does not cover these rules):",
				"- 199.5 Kites near airports:",
				"  - (a) Line length",
				"  - (b) Distance from a runway",
				"- 199.7 Lights on kites at night",
			].join("\n"),
		);
	});

	it("a Task with risk lines only", () => {
		const found = findLesson(course, "l05")!;
		const riskOnly = { ...found, lesson: { ...found.lesson, acs: [{ ...found.lesson.acs[0]!, elements: found.lesson.acs[0]!.elements.filter((e) => e.type === "R") }] } };
		assert.equal(firstMessage(riskOnly).split("\n\n")[2], `From the Private Pilot ACS (FAA-S-ACS-6C), Task II.A, Launching. ${R_ONLY_LEAD}\n- R1 Line burns.`);
	});

	it("holds no ids, nothing about the student but who they are, and fits in the chat address", () => {
		for (const found of allLessons(course)) {
			const m = firstMessage(found);
			assert.equal(m.includes(found.lesson.id), false);
			assert.equal(m.includes("ZZ."), false, "short element codes only");
			assert.doesNotMatch(m, /hours|soloed|Warrior|KSNS|Salinas|not part of this lesson/i);
			assert.ok(startUrlBytes(m) <= MAX_START_URL_BYTES);
		}
		assert.equal(startUrlBytes("a b"), "/chat/".length + 128 + "?prompt=".length + "a%20b".length);
	});
});
