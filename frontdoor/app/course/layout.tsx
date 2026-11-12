import type { ReactNode } from "react";
import { LegalNoticeLine } from "../../legal-notices/notice.tsx";

/**
 * The course page's frame (frontdoor/course): the account pages' look,
 * without Clerk (the gateway and the page check the front door's own login
 * cookie), plus the AGPL legal notices at the bottom.
 */

// The page reads the login cookie per request.
export const dynamic = "force-dynamic";

export const metadata = { title: "Ground school | North Aero Ground Tutor", robots: { index: false, follow: false } };

export default function CourseLayout({ children }: { children: ReactNode }) {
	return (
		<div style={{ fontFamily: "system-ui, sans-serif", display: "flex", flexDirection: "column", minHeight: "100vh", color: "#1a1b1d" }}>
			<div style={{ flex: 1 }}>{children}</div>
			<footer style={{ padding: "12px 16px", textAlign: "center" }}>
				<LegalNoticeLine commit={process.env.RAILWAY_GIT_COMMIT_SHA} />
			</footer>
		</div>
	);
}
