/**
 * Student names for the dashboard. The tutor's database keeps only each
 * login's Clerk user id, so names and emails come from Clerk's backend API
 * (read-only), on the server, cached for a few minutes. They are shown to
 * the Owner only and never written to a log. If Clerk cannot be reached,
 * the dashboard shows a short tenant id instead.
 */

export interface StudentName {
	name: string | null;
	email: string | null;
}

export interface StudentDirectory {
	lookup(clerkUserIds: readonly string[]): Promise<Map<string, StudentName>>;
}

/** The slice of Clerk's backend client this uses (@clerk/backend `users.getUserList`). */
export interface ClerkUsersApi {
	users: {
		getUserList(params: { userId: string[]; limit: number }): Promise<{
			data: Array<{
				id: string;
				firstName: string | null;
				lastName: string | null;
				primaryEmailAddress?: { emailAddress: string } | null;
				emailAddresses?: Array<{ emailAddress: string }>;
			}>;
		}>;
	};
}

const PAGE = 100;

export function clerkDirectory(client: ClerkUsersApi, options: { ttlMs?: number; now?: () => number; log?: (line: string) => void } = {}): StudentDirectory {
	const ttl = options.ttlMs ?? 5 * 60_000;
	const now = options.now ?? Date.now;
	const cache = new Map<string, { at: number; value: StudentName }>();
	return {
		async lookup(ids) {
			const out = new Map<string, StudentName>();
			const missing: string[] = [];
			for (const id of new Set(ids)) {
				const hit = cache.get(id);
				if (hit && now() - hit.at < ttl) out.set(id, hit.value);
				else missing.push(id);
			}
			for (let i = 0; i < missing.length; i += PAGE) {
				const batch = missing.slice(i, i + PAGE);
				try {
					const { data } = await client.users.getUserList({ userId: batch, limit: PAGE });
					for (const user of data) {
						const name = [user.firstName, user.lastName].filter(Boolean).join(" ").trim() || null;
						const email = user.primaryEmailAddress?.emailAddress ?? user.emailAddresses?.[0]?.emailAddress ?? null;
						const value = { name, email };
						cache.set(user.id, { at: now(), value });
						out.set(user.id, value);
					}
				} catch (error) {
					// No user data in the line (cross-cutting req 3).
					options.log?.(`student names unavailable from Clerk: ${(error as { status?: number }).status ?? "network error"}`);
				}
			}
			return out;
		},
	};
}

export const noDirectory: StudentDirectory = { lookup: async () => new Map() };
