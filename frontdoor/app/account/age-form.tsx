/**
 * The "I am 18 or older" checkbox (PRD C1 req 5, D28). It posts to the
 * gateway (POST /account/age), which sets the signed age cookie. Clerk's
 * sign-up form appears only after that (Owner, 2026-11-08).
 */
export function AgeForm({ next, back, error }: { next: string; back: string; error: boolean }) {
	return (
		<main style={{ maxWidth: 420, padding: 24 }}>
			<h1>North Aero Ground Tutor</h1>
			<form method="post" action="/account/age">
				<input type="hidden" name="next" value={next} />
				<input type="hidden" name="back" value={back} />
				<p>
					<label>
						<input type="checkbox" name="over18" value="yes" required /> I am 18 or older.
					</label>
				</p>
				{error ? <p role="alert">You must be 18 or older to sign up.</p> : null}
				<button type="submit">Continue</button>
			</form>
		</main>
	);
}
