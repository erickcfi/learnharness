import { ClerkProvider } from "@clerk/nextjs";
import type { ReactNode } from "react";

export const metadata = { title: "North Aero Ground Tutor" };

// Every page reads cookies or Clerk's state per request.
export const dynamic = "force-dynamic";

export default function RootLayout({ children }: { children: ReactNode }) {
	return (
		<ClerkProvider signInUrl="/account/sign-in" signUpUrl="/account/sign-up">
			<html lang="en">
				<body style={{ fontFamily: "system-ui, sans-serif", display: "grid", placeItems: "center", minHeight: "100vh", margin: 0 }}>{children}</body>
			</html>
		</ClerkProvider>
	);
}
