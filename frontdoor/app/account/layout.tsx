import { ClerkProvider } from "@clerk/nextjs";
import type { ReactNode } from "react";
import { LegalNoticeLine } from "../../legal-notices/notice.tsx";

/**
 * The account pages (sign in, sign up, 18+, sign out). Clerk lives here,
 * not in the root layout, so the public pages load no Clerk script (W2-11:
 * no third-party scripts on public pages). The look is unchanged, plus the
 * AGPL legal notices at the bottom (frontdoor/legal-notices).
 */

// Every account page reads cookies or Clerk's state per request.
export const dynamic = "force-dynamic";

export default function AccountLayout({ children }: { children: ReactNode }) {
	return (
		<ClerkProvider signInUrl="/account/sign-in" signUpUrl="/account/sign-up">
			<div style={{ fontFamily: "system-ui, sans-serif", display: "flex", flexDirection: "column", minHeight: "100vh" }}>
				<div style={{ flex: 1, display: "grid", placeItems: "center" }}>{children}</div>
				<footer style={{ padding: "12px 16px", textAlign: "center" }}>
					<LegalNoticeLine commit={process.env.RAILWAY_GIT_COMMIT_SHA} />
				</footer>
			</div>
		</ClerkProvider>
	);
}
