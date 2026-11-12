/**
 * Reads the course file from the library volume at run time
 * (<LH_LIBRARY_DIR>/course/private-pilot.course.json, put there by the
 * Owner's upload on /admin/library). It is read again only when its size or
 * time changes. No file, or a file that fails the check: null, and /course
 * says the course is coming soon. A bad file is logged once.
 */
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { COURSE_AREA, COURSE_FILE_NAME, COURSE_MAX_BYTES, type CourseFile, parseCourseBytes } from "./file.ts";

export interface CourseSource {
	load(): Promise<CourseFile | null>;
}

export function courseFilePath(libraryDir: string): string {
	return path.join(libraryDir, COURSE_AREA, COURSE_FILE_NAME);
}

export function libraryCourseSource(libraryDir: string, log?: (line: string) => void): CourseSource {
	let cached: { key: string; course: CourseFile | null } | null = null;
	return {
		async load() {
			const file = courseFilePath(libraryDir);
			let key: string;
			try {
				const stat = await fsp.lstat(file);
				if (!stat.isFile()) return null;
				key = `${stat.size}:${stat.mtimeMs}`;
				if (stat.size > COURSE_MAX_BYTES) {
					if (cached?.key !== key) log?.("course: the course file is too large; /course says the course is coming soon");
					cached = { key, course: null };
					return null;
				}
			} catch {
				cached = null;
				return null;
			}
			if (cached?.key === key) return cached.course;
			let course: CourseFile | null = null;
			try {
				const checked = parseCourseBytes(await fsp.readFile(file));
				if (checked.ok) course = checked.course;
				else log?.(`course: the course file is not valid (${checked.error}); /course says the course is coming soon`);
			} catch (error) {
				log?.(`course: could not read the course file (${(error as NodeJS.ErrnoException).code ?? "error"})`);
			}
			cached = { key, course };
			return course;
		},
	};
}
