"use client";

import { useClerk } from "@clerk/nextjs";
import { useEffect } from "react";

/** Ends the Clerk session. The gateway clears the front door's cookies on
 *  this same request, before the page loads. */
export default function SignOutPage() {
	const { signOut } = useClerk();
	useEffect(() => {
		void signOut({ redirectUrl: "/account/sign-in" });
	}, [signOut]);
	return (
		<main>
			<p>Signing out…</p>
		</main>
	);
}
