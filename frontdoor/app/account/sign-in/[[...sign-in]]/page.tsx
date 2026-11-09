import { SignIn } from "@clerk/nextjs";
import { safeReturnPath } from "../../../../gateway/return-path.ts";

/** Sign-in. After it, Clerk sends the student to /account/start, which sets
 *  the front door's login cookie and returns to where they were going. */
export default async function SignInPage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
	const next = safeReturnPath((await searchParams).next, "/");
	return (
		<main>
			<SignIn path="/account/sign-in" signUpUrl="/account/sign-up" forceRedirectUrl={`/account/start?next=${encodeURIComponent(next)}`} />
		</main>
	);
}
