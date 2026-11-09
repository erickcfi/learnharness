import type { ReactNode } from "react";

export const metadata = { title: "North Aero Ground Tutor" };

/**
 * The root layout: only the page shell. Clerk is in app/account/layout.tsx
 * and the public pages' frame is in app/(public)/layout.tsx (W2-11), so the
 * public pages carry no Clerk script and can be built ahead of time.
 */
export default function RootLayout({ children }: { children: ReactNode }) {
	return (
		<html lang="en">
			<body style={{ margin: 0 }}>{children}</body>
		</html>
	);
}
