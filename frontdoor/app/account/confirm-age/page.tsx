import { safeReturnPath } from "../../../gateway/return-path.ts";
import { AgeForm } from "../age-form.tsx";

/** For a signed-in student with no 18+ tick on file (for example, one who
 *  reached Clerk's form another way). No tenant exists until it is ticked. */
export default async function ConfirmAgePage({ searchParams }: { searchParams: Promise<{ next?: string; age?: string }> }) {
	const { next: rawNext, age } = await searchParams;
	const next = safeReturnPath(rawNext, "/");
	const back = `/account/confirm-age?next=${encodeURIComponent(next)}`;
	return <AgeForm next={`/account/start?next=${encodeURIComponent(next)}`} back={back} error={age === "required"} />;
}
