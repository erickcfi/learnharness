import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { getAdminRuntime } from "../../../admin/registry.ts";
import { SHARING_COPY as C } from "../../../sharing/copy.ts";
import { SHARING_PATH } from "../../../sharing/paths.ts";

/**
 * The student's session-text switch (P3-04, C7 req 3, D19): off by default,
 * stored with its date. The form posts to the front door, which changes
 * only the signed-in student's own switch (frontdoor/sharing).
 */
export default async function SharingPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
	const rt = getAdminRuntime();
	const state = rt ? await rt.studentSharing((await headers()).get("cookie") ?? undefined) : null;
	if (!state) redirect(`/account/sign-in?next=${encodeURIComponent("/account/sharing")}`);
	const saved = (await searchParams).saved;
	return (
		<main style={{ maxWidth: 520, padding: 16, lineHeight: 1.5 }}>
			<h1 style={{ fontSize: 24 }}>{C.title}</h1>
			{saved === "on" && <p role="status">{C.savedOn}</p>}
			{saved === "off" && <p role="status">{C.savedOff}</p>}
			{C.intro.map((line) => (
				<p key={line}>{line}</p>
			))}
			<form method="post" action={SHARING_PATH}>
				<label style={{ display: "flex", gap: 10, alignItems: "flex-start", fontSize: 17, margin: "16px 0" }}>
					<input type="checkbox" name="share" value="on" defaultChecked={state.optedIn} style={{ width: 22, height: 22 }} />
					<span>{C.label}</span>
				</label>
				<p style={{ fontSize: 14, color: "#555" }}>{C.help}</p>
				<button type="submit" style={{ font: "inherit", fontSize: 16, padding: "10px 18px", borderRadius: 8, border: "1px solid #1a1b1d", background: "#1a1b1d", color: "#fff" }}>
					{C.save}
				</button>
			</form>
			<p style={{ marginTop: 24 }}>
				{/* A full page load on purpose: for a signed-in student "/" is the tutor, which Next.js does not serve. */}
				{/* eslint-disable-next-line @next/next/no-html-link-for-pages */}
				<a href="/">{C.back}</a>
			</p>
		</main>
	);
}
