import { ClerkProvider } from "@clerk/nextjs";
import type { ReactNode } from "react";

/**
 * The account pages (sign in, sign up, 18+, sign out). Clerk lives here,
 * not in the root layout, so the public pages load no Clerk script (W2-11:
 * no third-party scripts on public pages). The look is unchanged.
 */

// Every account page reads cookies or Clerk's state per request.
export const dynamic = "force-dynamic";

export default function AccountLayout({ children }: { children: ReactNode }) {
	return (
		<ClerkProvider signInUrl="/account/sign-in" signUpUrl="/account/sign-up">
			<div style={{ fontFamily: "system-ui, sans-serif", display: "grid", placeItems: "center", minHeight: "100vh" }}>{children}</div>
		</ClerkProvider>
	);
}
