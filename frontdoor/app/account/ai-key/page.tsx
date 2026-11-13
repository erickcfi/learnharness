import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { OWN_KEY_COPY as C } from "../../../own-key/copy.ts";
import { OWN_KEY_PAGE } from "../../../own-key/paths.ts";
import { getOwnKeyRuntime, type OwnKeyPageState } from "../../../own-key/registry.ts";
import { AiKeyView, noticeFrom } from "./ai-key-view.tsx";

export const metadata = { title: C.title };

/**
 * The student's own AI key (master decision, 2026-11-13): paste an
 * Anthropic key, the front door checks it with Anthropic and saves it
 * encrypted; the page shows only its last 4 characters. The forms post to
 * the front door (frontdoor/own-key/endpoint.ts), which changes only the
 * signed-in student's own key.
 */
export default async function AiKeyPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
	const rt = getOwnKeyRuntime();
	const notice = noticeFrom(await searchParams);
	if (!rt) return <AiKeyView state="unavailable" notice={notice} timeZone="America/Los_Angeles" />;
	const cookie = (await headers()).get("cookie") ?? undefined;
	let state: OwnKeyPageState | null | "unavailable";
	try {
		state = await rt.state(cookie);
	} catch {
		state = "unavailable";
	}
	// redirect() throws on purpose, so it stays outside the try.
	if (state === null) redirect(`/account/sign-in?next=${encodeURIComponent(OWN_KEY_PAGE)}`);
	return <AiKeyView state={state} notice={notice} timeZone={rt.timeZone} />;
}
