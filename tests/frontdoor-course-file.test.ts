/**
 * The guided course (master, 2026-11-11): the course file check, the
 * converter from Groundwork's data, and a lesson's first message. Every
 * course here is invented (tests/fixtures/frontdoor-course); the real course
 * data never goes in this repo.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import { buildCourse, COURSE_TITLE, splitAcs, writeCourseFile } from "../frontdoor/course/build-course-file.ts";
import { courseCounts, findLeg, parseCourseBytes, parseCourseFile } from "../frontdoor/course/file.ts";
import { firstMessage, STUDENT_LINE } from "../frontdoor/course/first-message.ts";
import { SAMPLE_GROUNDWORK as GROUNDWORK, sampleCourse } from "./helpers/frontdoor-course.ts";

const REPO = path.join(import.meta.dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lh-course-file-"));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const copy = <T>(v: T): T => structuredClone(v);

describe("the course file check", () => {
	it("accepts a lean course file and counts it", () => {
		const r = parseCourseFile(sampleCourse());
		assert.ok(r.ok, r.ok ? "" : r.error);
		assert.deepEqual(courseCounts(r.course), { stages: 2, subjects: 2, legs: 3 });
		assert.equal(findLeg(r.course, "folding-the-dart")?.subject.id, "paper-planes");
		assert.equal(findLeg(r.course, "nope"), null);
		assert.equal(findLeg(r.course, "../etc"), null);
		assert.equal(findLeg(r.course, 42), null);
	});

	it("refuses any field the format does not name, so statements, passages or quizzes cannot slip in", () => {
		const cases: Array<[string, (c: Record<string, any>) => void]> = [
			["a statement on a Leg", (c) => (c.stages[0].subjects[0].legs[0].text = "A key point statement")],
			["key points as objects", (c) => (c.stages[0].subjects[0].legs[0].keyPoints = [{ label: "x", text: "statement" }])],
			["passages on a subject", (c) => (c.stages[0].subjects[0].citations = [])],
			["a quiz on the course", (c) => (c.quizzes = [])],
			["a brief on a stage", (c) => (c.stages[0].brief = "x")],
		];
		for (const [what, change] of cases) {
			const c = copy(sampleCourse()) as unknown as Record<string, any>;
			change(c);
			const r = parseCourseFile(c);
			assert.equal(r.ok, false, what);
		}
		const r = parseCourseFile({ ...sampleCourse(), quizzes: [] });
		assert.ok(!r.ok && /does not allow: quizzes/.test(r.error), "the error names the field");
	});

	it("refuses a wrong format, version, id, empty or long text, and repeated ids", () => {
		const bad: Array<[string, (c: Record<string, any>) => void]> = [
			["format", (c) => (c.format = "groundwork")],
			["version", (c) => (c.version = 2)],
			["course id", (c) => (c.id = "Sample Course")],
			["leg id", (c) => (c.stages[0].subjects[0].legs[0].id = "../x")],
			["empty title", (c) => (c.stages[0].subjects[0].legs[0].title = "  ")],
			["long outcome", (c) => (c.stages[0].subjects[0].legs[0].outcome = "x".repeat(401))],
			["no key points", (c) => (c.stages[0].subjects[0].legs[0].keyPoints = [])],
			["no stages", (c) => (c.stages = [])],
			["no legs", (c) => (c.stages[0].subjects[0].legs = [])],
			["acs not text", (c) => (c.stages[0].subjects[0].legs[0].acs = [7])],
			["control character", (c) => (c.stages[0].subjects[0].legs[0].title = "a\u0007b")],
			["repeated Leg id", (c) => c.stages[0].subjects.push({ id: "kites", title: "Kites", legs: [copy(c.stages[0].subjects[0].legs[0])] })],
			["repeated subject", (c) => c.stages[0].subjects.push(copy(c.stages[0].subjects[0]))],
			["repeated stage", (c) => c.stages.push({ ...copy(c.stages[0]), subjects: [{ id: "kites", title: "Kites", legs: [{ ...copy(c.stages[0].subjects[0].legs[0]), id: "other" }] }] })],
		];
		for (const [what, change] of bad) {
			const c = copy(sampleCourse()) as unknown as Record<string, any>;
			change(c);
			assert.equal(parseCourseFile(c).ok, false, what);
		}
		for (const v of [null, [], "x", 3]) assert.equal(parseCourseFile(v).ok, false);
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
		const c = copy(sampleCourse());
		c.stages[0]!.subjects[0]!.legs[0]!.title = "  Folding the dart ";
		const r = parseCourseFile(c);
		assert.ok(r.ok);
		assert.equal(r.course.stages[0]!.subjects[0]!.legs[0]!.title, "Folding the dart");
	});
});

describe("the converter (build-course-file.ts), on invented Groundwork data", () => {
	it("groups Legs by stage, then subject, with title, outcome, ACS codes and key point labels only", () => {
		const course = buildCourse(GROUNDWORK);
		assert.equal(course.id, "sample-course");
		assert.equal(course.title, COURSE_TITLE);
		assert.deepEqual(
			course.stages.map((s) => [s.id, s.title, s.subjects.map((sub) => [sub.id, sub.title, sub.legs.map((l) => l.id)])]),
			[
				["solo", "Before you solo", [["paper-planes", "Paper planes", ["folding-the-dart"]], ["kite-flying", "Kite flying", ["picking-a-field"]]]],
				["cross-country", "Before cross-country", [["paper-planes", "Paper planes", ["trimming-the-wings"]]]],
				["checkride", "Checkride prep", [["kite-flying", "Kite flying", ["line-tension"]]]],
			],
		);
		assert.deepEqual(findLeg(course, "folding-the-dart")?.leg, {
			id: "folding-the-dart",
			title: "Folding the dart",
			outcome: "Fold a dart that flies straight across the room.",
			acs: ["ZZ.I.A.K1", "ZZ.I.A.K2", "ZZ.I.B.K1, K2"],
			keyPoints: ["Which paper to use", "The center fold", "Folding the nose"],
		});
		assert.deepEqual(findLeg(course, "trimming-the-wings")?.leg.acs, ["ZZ.II.A.K1", "ZZ.II.A.R1"]);
		assert.deepEqual(findLeg(course, "line-tension")?.leg, { id: "line-tension", title: "Line tension", outcome: "Keep the line tight as the wind drops.", acs: [], keyPoints: ["Pulling in line"] });
		assert.deepEqual(courseCounts(course), { stages: 3, subjects: 2, legs: 4 });
	});

	it("leaves out statements, passages, notes, Point ids and everything else", () => {
		const out = path.join(tmp, "out", "sample.course.json");
		const r = writeCourseFile(GROUNDWORK, out);
		assert.deepEqual({ stages: r.stages, subjects: r.subjects, legs: r.legs }, { stages: 3, subjects: 2, legs: 4 });
		const text = fs.readFileSync(out, "utf8");
		assert.equal(r.bytes, Buffer.byteLength(text));
		for (const secret of ["SECRET", "made-up owner note", "9-1.p0", "together", "figures", "loadBearing", "replacedBy", "citations", "\"text\"", "\"points\"", "\"when\""]) {
			assert.equal(text.includes(secret), false, `the course file holds ${secret}`);
		}
		assert.ok(parseCourseBytes(fs.readFileSync(out)).ok, "what it writes passes the upload check");
	});

	it("splits ACS strings on semicolons only", () => {
		assert.deepEqual(splitAcs("A.1; B.2;C.3 ; "), ["A.1", "B.2", "C.3"]);
		assert.deepEqual(splitAcs("PA.I.F.K3, K2e"), ["PA.I.F.K3, K2e"]);
		assert.deepEqual(splitAcs(undefined), []);
	});

	it("stops, naming the problem, when a label is missing or a Leg has no stage", () => {
		const broken = path.join(tmp, "broken");
		fs.cpSync(GROUNDWORK, broken, { recursive: true });
		const legsFile = path.join(broken, "scripts", "courses", "legs", "kite-flying.json");
		const legs = JSON.parse(fs.readFileSync(legsFile, "utf8"));
		delete legs.labels["9-2.p02"];
		fs.writeFileSync(legsFile, JSON.stringify(legs));
		assert.throws(() => buildCourse(broken), /label of Point 9-2\.p02/);

		const stageless = path.join(tmp, "stageless");
		fs.cpSync(GROUNDWORK, stageless, { recursive: true });
		const indexFile = path.join(stageless, "src", "content", "course", "index.json");
		const index = JSON.parse(fs.readFileSync(indexFile, "utf8"));
		index.subjects[0].legs[0].when = "someday";
		fs.writeFileSync(indexFile, JSON.stringify(index));
		assert.throws(() => buildCourse(stageless), /no known stage/);
	});

	it("runs from the command line with plain Node", () => {
		const out = path.join(tmp, "cli", "course.json");
		const run = spawnSync(process.execPath, [path.join(REPO, "frontdoor", "course", "build-course-file.ts"), GROUNDWORK, out], { encoding: "utf8" });
		assert.equal(run.status, 0, run.stderr);
		assert.match(run.stdout, /3 stages, 2 subjects, 4 Legs/);
		assert.ok(parseCourseBytes(fs.readFileSync(out)).ok);
		const usage = spawnSync(process.execPath, [path.join(REPO, "frontdoor", "course", "build-course-file.ts")], { encoding: "utf8" });
		assert.equal(usage.status, 2);
	});
});

describe("a lesson's first message", () => {
	const leg = sampleCourse().stages[0]!.subjects[0]!.legs[0]!;

	it("says who the student is, the Leg's title and outcome, its ACS codes, and its key point labels", () => {
		assert.equal(
			firstMessage(leg),
			[
				"I am a student pilot working toward the private pilot certificate. I would like to work on this lesson.",
				"",
				"Lesson: Folding the dart",
				"Outcome: Fold a dart that flies straight.",
				"ACS: ZZ.I.A.K1; ZZ.I.B.K1, K2",
				"",
				"This lesson should cover:",
				"- Which paper to use",
				"- The center fold",
			].join("\n"),
		);
		assert.ok(firstMessage(leg).startsWith(STUDENT_LINE));
	});

	it("holds no ids, and leaves out the ACS line when there are no codes", () => {
		const message = firstMessage({ ...leg, acs: [] });
		assert.equal(message.includes("ACS"), false);
		assert.equal(message.includes(leg.id), false);
		const built = buildCourse(GROUNDWORK);
		for (const stage of built.stages) {
			for (const subject of stage.subjects) {
				for (const l of subject.legs) {
					const m = firstMessage(l);
					assert.equal(m.includes(l.id), false);
					assert.equal(m.includes(subject.id), false);
					assert.doesNotMatch(m, /SECRET|9-\d\.p\d/);
				}
			}
		}
	});
});
