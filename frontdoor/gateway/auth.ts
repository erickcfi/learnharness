/**
 * What the gateway needs from Clerk. clerk.ts implements it with Clerk's
 * backend SDK; tests use a fake.
 */
export type ClerkAuthResult =
	| { status: "signed-in"; userId: string; sessionId: string; headers?: Headers }
	| { status: "handshake"; headers: Headers }
	| { status: "signed-out" };

export interface ClerkGateway {
	/** Checks the Clerk login on a page request (used by /account/start). */
	authenticate(request: Request): Promise<ClerkAuthResult>;
	/** Whether a Clerk session is still active (the 5-minute re-check). */
	isSessionActive(sessionId: string): Promise<boolean>;
	/** W2-7: deletes a student's Clerk user on day 91. A user Clerk no longer has counts as deleted. */
	deleteUser?(userId: string): Promise<void>;
}
