/**
 * One-time step: give the Owner role to a Clerk user who has signed in once.
 *
 *   SUPABASE_DB_URL='<session pooler URL>' npx tsx frontdoor/admin/grant-owner.ts user_2abc...
 *   SUPABASE_DB_URL='<session pooler URL>' npx tsx frontdoor/admin/grant-owner.ts --list
 *
 * Prints no secret. Exits 1 when the user has no account yet.
 */
import { connectDatabase } from "../wiring/database.ts";
import { grantOwnerByClerkId, listRoleHolders } from "./owner.ts";

const url = process.env.SUPABASE_DB_URL;
const arg = process.argv[2];
if (!url || !arg) {
	process.stderr.write("Usage: SUPABASE_DB_URL=... npx tsx frontdoor/admin/grant-owner.ts <Clerk user id> | --list\n");
	process.exit(2);
}
const isLocal = /@(localhost|127\.0\.0\.1)[:/]/.test(url) || url.includes("host=/");
const connection = connectDatabase(url, { production: !isLocal });
try {
	if (arg === "--list") {
		for (const r of await listRoleHolders(connection.db)) process.stdout.write(`${r.role}\t${r.clerkUserId}\t${r.grantedAt.toISOString()}\n`);
	} else {
		const result = await grantOwnerByClerkId(connection.db, arg);
		if (!result.ok) {
			process.stderr.write(
				result.reason === "bad-id"
					? "That is not a Clerk user id (it starts with user_).\n"
					: "No account has that Clerk user id. Sign in once at the site first, then run this again.\n",
			);
			process.exitCode = 1;
		} else {
			process.stdout.write(result.alreadyOwner ? `Already the Owner (account ${result.accountId}).\n` : `Owner role granted (account ${result.accountId}).\n`);
		}
	}
} finally {
	await connection.close();
}
