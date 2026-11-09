/**
 * The student's name and login email, from Clerk (the tutor's database
 * holds neither). The name heads each report; the login email fills the
 * address box the first time the student opens the report settings.
 *
 * Neither is ever written to a log (cross-cutting req 3).
 */
import { createClerkClient } from "@clerk/backend";
import type { Db } from "../db/db.ts";
import { clerkUserIdForTenant } from "./store.ts";

export interface StudentProfile {
	/** First and last name; null when the account has none. */
	name: string | null;
	/** The primary login email; null when Clerk has none. */
	email: string | null;
}

export interface StudentDirectory {
	/** Null when the tenant or its login is unknown. Throws when Clerk cannot be reached. */
	get(tenantId: string): Promise<StudentProfile | null>;
}

/** What the directory needs from Clerk's backend client. */
export interface ClerkUsersLike {
	getUser(userId: string): Promise<{
		firstName: string | null;
		lastName: string | null;
		primaryEmailAddressId: string | null;
		emailAddresses: ReadonlyArray<{ id: string; emailAddress: string }>;
	}>;
}

export function profileFromClerkUser(user: Awaited<ReturnType<ClerkUsersLike["getUser"]>>): StudentProfile {
	const name = [user.firstName, user.lastName]
		.map((part) => (part ?? "").trim())
		.filter(Boolean)
		.join(" ");
	const primary = user.emailAddresses.find((e) => e.id === user.primaryEmailAddressId) ?? user.emailAddresses[0];
	return { name: name || null, email: primary?.emailAddress ?? null };
}

export function createClerkStudentDirectory(db: Db, users: ClerkUsersLike): StudentDirectory {
	return {
		async get(tenantId) {
			const userId = await clerkUserIdForTenant(db, tenantId);
			if (!userId) return null;
			try {
				return profileFromClerkUser(await users.getUser(userId));
			} catch (error) {
				if ((error as { status?: number }).status === 404) return null;
				throw error;
			}
		},
	};
}

/** Clerk's backend client, from the front door's Clerk settings. */
export function clerkUsers(settings: { secretKey: string; publishableKey: string }): ClerkUsersLike {
	return createClerkClient({ secretKey: settings.secretKey, publishableKey: settings.publishableKey }).users;
}

/** For tests and local runs. */
export class MemoryStudentDirectory implements StudentDirectory {
	readonly #profiles = new Map<string, StudentProfile>();

	set(tenantId: string, profile: StudentProfile): void {
		this.#profiles.set(tenantId, profile);
	}

	async get(tenantId: string): Promise<StudentProfile | null> {
		return this.#profiles.get(tenantId) ?? null;
	}
}
