/**
 * Email settings (PRD C6 req 3 to 5, N1, PD7; SES checklist in
 * docs/decisions/2026-11-08-ses-checklist.md).
 *
 * Fixed values (not variables): the sending identity, the Reply-To and the
 * SES configuration set. They come from the approved checklist.
 *
 * Railway variables (secrets live only there, cross-cutting req 2):
 *   SES_REGION             the AWS Region of flynorth's SES, e.g. us-west-2
 *   SES_ACCESS_KEY_ID      an access key for an IAM user that may only send
 *   SES_SECRET_ACCESS_KEY  its secret
 *   OWNER_ALERT_EMAIL      optional: where Owner alerts go (none when unset)
 *   FRONTDOOR_PUBLIC_URL   optional: the site address used in email links,
 *                          default https://ground.flynorthaero.com
 *
 * Modes:
 *   ses     production, with all three SES variables set: real email.
 *   off     production, with none of them set: nothing is sent, the front
 *           door still starts (one log line). Report settings still save.
 *   memory  outside production: the in-memory fake. Nothing leaves the
 *           machine, even when the SES variables are set (tests, local runs).
 * A partial SES set in production fails the start check, naming what is
 * missing. Messages name variables, never their values.
 */
import { CONTACT_EMAIL, SITE_ORIGIN } from "../marketing/site.ts";
import { isValidEmailAddress } from "./address.ts";

type Env = Readonly<Record<string, string | undefined>>;

/** N1. A verified domain covers every address in it (checklist, step 8). */
export const EMAIL_FROM_ADDRESS = "reports@ground.flynorthaero.com";
export const EMAIL_FROM_NAME = "North Aero Ground Tutor";
/** PD7. Mail sent to reports@ cannot be received. */
export const EMAIL_REPLY_TO = CONTACT_EMAIL;
/** C6 req 5: separate from flynorth's. Also the identity's default set. */
export const SES_CONFIGURATION_SET = "ground-tutor-reports";

export const SES_VARIABLES = ["SES_REGION", "SES_ACCESS_KEY_ID", "SES_SECRET_ACCESS_KEY"] as const;

export type EmailMode = "ses" | "off" | "memory";

export interface SesSettings {
	region: string;
	accessKeyId: string;
	secretAccessKey: string;
}

export interface EmailConfig {
	mode: EmailMode;
	/** Only in mode "ses". */
	ses?: SesSettings;
	/** OWNER_ALERT_EMAIL, when set. */
	ownerAlertEmail?: string;
	/** The site address in email links, without a trailing slash. */
	publicUrl: string;
}

const isSet = (env: Env, name: string) => typeof env[name] === "string" && env[name]!.trim() !== "";

/** One message per problem; empty when the email variables are fine. */
export function emailEnvProblems(env: Env): string[] {
	const problems: string[] = [];
	const production = env.NODE_ENV === "production";
	const set = SES_VARIABLES.filter((name) => isSet(env, name));
	if (production && set.length > 0 && set.length < SES_VARIABLES.length) {
		const missing = SES_VARIABLES.filter((name) => !isSet(env, name));
		problems.push(`${missing.join(", ")} ${missing.length === 1 ? "is" : "are"} not set. Report email needs all of ${SES_VARIABLES.join(", ")}, or none of them (email off).`);
	}
	if (isSet(env, "SES_REGION") && !/^[a-z]{2}(-[a-z]+)+-\d$/.test(env.SES_REGION!.trim())) {
		problems.push("SES_REGION must be an AWS Region code, for example us-west-2.");
	}
	if (isSet(env, "OWNER_ALERT_EMAIL") && !isValidEmailAddress(env.OWNER_ALERT_EMAIL!.trim())) {
		problems.push("OWNER_ALERT_EMAIL must be one email address.");
	}
	if (isSet(env, "FRONTDOOR_PUBLIC_URL")) {
		const raw = env.FRONTDOOR_PUBLIC_URL!.trim();
		let url: URL | null = null;
		try {
			url = new URL(raw);
		} catch {
			url = null;
		}
		if (!url || (url.protocol !== "https:" && url.protocol !== "http:") || url.pathname.replace(/\/+$/, "") !== "" || url.search || url.hash) {
			problems.push("FRONTDOOR_PUBLIC_URL must be the site's origin only, for example https://ground.flynorthaero.com.");
		} else if (production && url.protocol !== "https:") {
			problems.push("FRONTDOOR_PUBLIC_URL must start with https:// in production.");
		}
	}
	return problems;
}

/** The start check (wiring/env.ts STARTUP_CHECKS). */
export function assertEmailEnv(env: Env): void {
	const problems = emailEnvProblems(env);
	if (problems.length > 0) throw new Error(problems.join("\n- "));
}

export function loadEmailConfig(env: Env): EmailConfig {
	assertEmailEnv(env);
	const production = env.NODE_ENV === "production";
	const allSes = SES_VARIABLES.every((name) => isSet(env, name));
	const mode: EmailMode = !production ? "memory" : allSes ? "ses" : "off";
	const publicUrl = (isSet(env, "FRONTDOOR_PUBLIC_URL") ? env.FRONTDOOR_PUBLIC_URL!.trim() : SITE_ORIGIN).replace(/\/+$/, "");
	return {
		mode,
		...(mode === "ses"
			? { ses: { region: env.SES_REGION!.trim(), accessKeyId: env.SES_ACCESS_KEY_ID!.trim(), secretAccessKey: env.SES_SECRET_ACCESS_KEY!.trim() } }
			: {}),
		...(isSet(env, "OWNER_ALERT_EMAIL") ? { ownerAlertEmail: env.OWNER_ALERT_EMAIL!.trim() } : {}),
		publicUrl,
	};
}
