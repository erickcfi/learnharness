/**
 * The student's email from Clerk (W2-8). Billing needs it for the one-trial
 * check (as a keyed hash) and for the Stripe customer. The front door's own
 * database holds no email addresses, and logs never carry one.
 */
import { createClerkClient } from "@clerk/backend";

export type EmailLookup = (userId: string) => Promise<string | null>;

/** Clerk's primary email for the user, remembered for 5 minutes. */
export function clerkEmailLookup(secretKey: string, options: { now?: () => number; ttlMs?: number } = {}): EmailLookup {
	const clerk = createClerkClient({ secretKey });
	const now = options.now ?? Date.now;
	const ttl = options.ttlMs ?? 5 * 60 * 1000;
	const cache = new Map<string, { at: number; email: string | null }>();
	return async (userId) => {
		const hit = cache.get(userId);
		if (hit && now() - hit.at < ttl) return hit.email;
		const user = await clerk.users.getUser(userId);
		const email = user.primaryEmailAddress?.emailAddress ?? null;
		cache.set(userId, { at: now(), email });
		return email;
	};
}
