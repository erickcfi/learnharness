import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { getCourseRuntime } from "../../course/registry.ts";
import { courseRedirect } from "../../course/view.ts";
import { CourseScreen } from "./course-screen.tsx";

/**
 * The guided course (master, 2026-11-11): stages, subjects and Legs from the
 * course file on the library volume, with "Start lesson" on each Leg. The
 * gateway has already checked the login; the runtime checks it again, with
 * the 18+ tick, as the /account pages do. Without the front door's runtime
 * (Next.js started alone), the page is "not found".
 */
export default async function CoursePage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
	const rt = getCourseRuntime();
	if (!rt) notFound();
	const state = await rt.page((await headers()).get("cookie") ?? undefined);
	const to = courseRedirect(state);
	if (to || state.status === "sign-in" || state.status === "confirm-age") redirect(to ?? "/account/sign-in");
	const error = (await searchParams).error;
	return <CourseScreen state={state} error={typeof error === "string" ? error : undefined} />;
}
