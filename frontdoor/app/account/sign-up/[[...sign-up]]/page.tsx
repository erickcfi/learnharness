import { SignUp } from "@clerk/nextjs";
import { cookies } from "next/headers";
import { AGE_COOKIE, sessionSecretFrom, verifyAgeConfirmation } from "../../../../gateway/session.ts";
import { AgeForm } from "../../age-form.tsx";

/** Sign-up: the 18+ checkbox first, then Clerk's form (Owner, 2026-11-08). */
export default async function SignUpPage({ searchParams }: { searchParams: Promise<{ age?: string }> }) {
	const jar = await cookies();
	const tickedAt = await verifyAgeConfirmation(jar.get(AGE_COOKIE)?.value, sessionSecretFrom(process.env.FRONTDOOR_SESSION_SECRET), Date.now());
	if (tickedAt === null) {
		const { age } = await searchParams;
		return <AgeForm next="/account/sign-up" back="/account/sign-up" error={age === "required"} />;
	}
	return (
		<main>
			<SignUp path="/account/sign-up" signInUrl="/account/sign-in" forceRedirectUrl="/account/start" />
		</main>
	);
}
