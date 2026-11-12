/**
 * The library's "Course" area (master, 2026-11-11): the Owner uploads the
 * one course file on /admin/library. It is stored as
 * <library>/course/private-pilot.course.json only when it passes the course
 * file check; anything else leaves nothing behind. The front door then reads
 * it from there (course/source.ts). Invented course data only.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { Readable } from "node:stream";
import { after, before, describe, it } from "node:test";
import { COURSE_FILE_NAME } from "../frontdoor/course/file.ts";
import { libraryCourseSource } from "../frontdoor/course/source.ts";
import { checkRelativePath, courseUploadName, LibraryError, LIBRARY_AREAS, listLibrary, removeLibraryFile, saveLibraryFile, targetFolder } from "../frontdoor/library/index.ts";
import { type Fixture, startFixture } from "./frontdoor-admin-fixture.ts";
import { sampleCourse, sampleCourseBytes } from "./helpers/frontdoor-course.ts";

let f: Fixture;
let owner: string;

before(async () => {
	f = await startFixture();
	owner = await f.cookie(f.owner.clerkUserId);
});
after(async () => {
	await f.close();
});

const stored = () => path.join(f.libraryDir, "course", COURSE_FILE_NAME);
const incomingLeft = () => {
	const dir = path.join(f.volume, ".library-incoming");
	return fs.existsSync(dir) ? fs.readdirSync(dir) : [];
};
function upload(query: string, body: Buffer | string, cookie = owner): Promise<Response> {
	return fetch(`${f.base}/admin/api/library?${query}`, {
		method: "PUT",
		headers: { Cookie: cookie, ...f.origin(), "Content-Type": "application/octet-stream" },
		body: typeof body === "string" ? body : new Uint8Array(body),
	});
}

describe("the Course area's rules", () => {
	it("is a library area beside the four the tutor's folders use, with one fixed file name", () => {
		assert.deepEqual([...LIBRARY_AREAS], ["faa", "ntsb", "poh", "north-aero", "course"]);
		assert.deepEqual(targetFolder("course", undefined), { ok: true, folder: "course" });
		assert.equal(courseUploadName("my course export.JSON"), COURSE_FILE_NAME);
		assert.equal(courseUploadName("course.pdf"), null);
		assert.equal(courseUploadName(undefined), null);
		assert.equal(checkRelativePath(`course/${COURSE_FILE_NAME}`), `course/${COURSE_FILE_NAME}`);
		for (const bad of ["course/other.json", "course/x/private-pilot.course.json", "course/../faa/x.pdf", "faa/private-pilot.course.json"]) assert.equal(checkRelativePath(bad), null, bad);
	});
});

describe("uploading the course file on /admin/library", () => {
	it("stores a valid file under its fixed name, whatever it was called", async () => {
		const res = await upload("area=course&name=sample.course.json", sampleCourseBytes());
		assert.equal(res.status, 200);
		const body = (await res.json()) as { file: { relPath: string }; replaced: boolean };
		assert.equal(body.file.relPath, `course/${COURSE_FILE_NAME}`);
		assert.deepEqual(fs.readFileSync(stored()), sampleCourseBytes());
		assert.deepEqual(incomingLeft(), []);
		const listed = await listLibrary(f.libraryDir);
		assert.ok(listed.some((x) => x.area === "course" && x.name === COURSE_FILE_NAME));
	});

	it("replaces it only when the Owner ticks Replace", async () => {
		const changed = sampleCourse();
		changed.title = "Sample ground school, second edition";
		const bytes = Buffer.from(JSON.stringify(changed));
		const again = await upload("area=course&name=course.json", bytes);
		assert.equal(again.status, 409);
		const replaced = await upload("area=course&name=course.json&replace=1", bytes);
		assert.equal(replaced.status, 200);
		assert.equal(((await replaced.json()) as { replaced: boolean }).replaced, true);
		assert.match(fs.readFileSync(stored(), "utf8"), /second edition/);
	});

	it("refuses anything that fails the check, and leaves the stored file as it was", async () => {
		const before = fs.readFileSync(stored());
		const withStatements = sampleCourse() as unknown as { stages: Array<{ subjects: Array<{ legs: Array<Record<string, unknown>> }> }> };
		withStatements.stages[0]!.subjects[0]!.legs[0]!.statements = ["A key point statement"];
		const cases: Array<[string, string, Buffer | string]> = [
			["not JSON", "course.json", "%PDF-1.7 not json"],
			["statements in a Leg", "course.json", Buffer.from(JSON.stringify(withStatements))],
			["wrong format", "course.json", Buffer.from(JSON.stringify({ ...sampleCourse(), format: "other" }))],
			["not a .json name", "course.txt", sampleCourseBytes()],
			["empty", "course.json", ""],
		];
		for (const [what, name, body] of cases) {
			const res = await upload(`area=course&name=${encodeURIComponent(name)}&replace=1`, body);
			assert.equal(res.status, 400, what);
			const answer = (await res.json()) as { error: string };
			assert.ok(answer.error.length > 0, what);
		}
		const statements = await upload("area=course&name=course.json&replace=1", Buffer.from(JSON.stringify(withStatements)));
		assert.match(((await statements.json()) as { error: string }).error, /not a valid course file: .*does not allow: statements/);
		assert.deepEqual(fs.readFileSync(stored()), before);
		assert.deepEqual(incomingLeft(), []);
	});

	it("needs the Owner", async () => {
		const student = await f.student();
		const res = await upload("area=course&name=course.json&replace=1", sampleCourseBytes(), await f.cookie(student.clerkUserId));
		assert.equal(res.status, 403);
	});

	it("stops a course file over 5 MB", async () => {
		const big = Readable.from([Buffer.from("{"), Buffer.alloc(3 * 1024 * 1024, 0x20), Buffer.alloc(3 * 1024 * 1024, 0x20)]);
		await assert.rejects(saveLibraryFile(f.libraryDir, big, { area: "course", fileName: "course.json", replace: true }), (e: unknown) => e instanceof LibraryError && e.code === "too-large");
		assert.deepEqual(incomingLeft(), []);
	});
});

describe("the front door reads the stored file", () => {
	it("loads it, notices a new upload, and says nothing is there after a remove", async () => {
		const lines: string[] = [];
		const source = libraryCourseSource(f.libraryDir, (l) => lines.push(l));
		await saveLibraryFile(f.libraryDir, Readable.from([sampleCourseBytes()]), { area: "course", fileName: "c.json", replace: true });
		assert.equal((await source.load())?.title, "Sample ground school");
		assert.equal((await source.load())?.title, "Sample ground school", "read again from its cache");

		const changed = sampleCourse();
		changed.title = "Sample ground school, revised";
		await new Promise((r) => setTimeout(r, 20));
		await saveLibraryFile(f.libraryDir, Readable.from([Buffer.from(JSON.stringify(changed))]), { area: "course", fileName: "c.json", replace: true });
		assert.equal((await source.load())?.title, "Sample ground school, revised");

		await removeLibraryFile(f.libraryDir, `course/${COURSE_FILE_NAME}`);
		assert.equal(await source.load(), null);
		assert.deepEqual(lines, []);
	});

	it("treats a broken file on the volume as no course, and logs it once", async () => {
		fs.mkdirSync(path.dirname(stored()), { recursive: true });
		fs.writeFileSync(stored(), JSON.stringify({ ...sampleCourse(), version: 9 }));
		const lines: string[] = [];
		const source = libraryCourseSource(f.libraryDir, (l) => lines.push(l));
		assert.equal(await source.load(), null);
		assert.equal(await source.load(), null);
		assert.equal(lines.length, 1);
		assert.match(lines[0]!, /course file is not valid \(version must be 1\)/);
		await removeLibraryFile(f.libraryDir, `course/${COURSE_FILE_NAME}`);
	});
});
