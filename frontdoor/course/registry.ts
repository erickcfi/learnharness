/**
 * How the /course page (app/course/) reaches the front door's data. The
 * page runs in the front door's process, but Next.js bundles it apart, so
 * module state is not shared. The front door puts one CourseRuntime on
 * globalThis at start (course/index.ts); the page reads it here. Without it
 * (Next.js started alone), the page is "not found". Same pattern as
 * admin/registry.ts.
 *
 * Types only, plus the globalThis slot.
 */
import type { CoursePageState } from "./view.ts";

export interface CourseRuntime {
	/** Checks the login cookie and the 18+ tick again (the gateway already checked the login), then builds the page. */
	page(cookieHeader: string | undefined): Promise<CoursePageState>;
}

const SLOT = Symbol.for("northaero.frontdoor.courseRuntime");

type Slot = { [SLOT]?: CourseRuntime | null };

export function registerCourseRuntime(runtime: CourseRuntime | null): void {
	(globalThis as Slot)[SLOT] = runtime;
}

export function getCourseRuntime(): CourseRuntime | null {
	return (globalThis as Slot)[SLOT] ?? null;
}
