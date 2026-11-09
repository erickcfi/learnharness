/**
 * The Clerk side of the login (PRD C1 req 1, D17), using Clerk's backend SDK.
 *
 * authenticate: checks the Clerk login on /account/start, the page Clerk
 * sends the student to after sign-in or sign-up. On a page request Clerk may
 * answer "handshake": a redirect through Clerk that renews its token, which
 * the gateway follows.
 *
 * isSessionActive: the 5-minute re-check behind the front door's own login
 * cookie (Owner, 2026-11-08).
 *
 * Tested by type checking only until the Owner's Clerk application exists;
 * the gateway tests use a fake.
 */
import { createClerkClient } from "@clerk/backend";
import type { ClerkAuthResult, ClerkGateway } from "./auth.ts";

export interface ClerkSettings {
	secretKey: string;
	publishableKey: string;
	jwtKey?: string;
	authorizedParties?: string[];
}

export function createClerkGateway(settings: ClerkSettings): ClerkGateway {
	const client = createClerkClient({
		secretKey: settings.secretKey,
		publishableKey: settings.publishableKey,
		...(settings.jwtKey ? { jwtKey: settings.jwtKey } : {}),
	});
	return {
		async authenticate(request: Request): Promise<ClerkAuthResult> {
			const state = await client.authenticateRequest(request, {
				...(settings.jwtKey ? { jwtKey: settings.jwtKey } : {}),
				...(settings.authorizedParties ? { authorizedParties: settings.authorizedParties } : {}),
				signInUrl: "/account/sign-in",
				signUpUrl: "/account/sign-up",
			});
			if (state.status === "handshake") return { status: "handshake", headers: state.headers };
			if (!state.isAuthenticated) return { status: "signed-out" };
			const auth = state.toAuth();
			if (!auth.userId || !auth.sessionId) return { status: "signed-out" };
			return { status: "signed-in", userId: auth.userId, sessionId: auth.sessionId, headers: state.headers };
		},
		async isSessionActive(sessionId: string): Promise<boolean> {
			try {
				const session = await client.sessions.getSession(sessionId);
				return session.status === "active";
			} catch (error) {
				// A session Clerk no longer knows is not active; any other error (network) is passed up.
				if ((error as { status?: number }).status === 404) return false;
				throw error;
			}
		},
	};
}
