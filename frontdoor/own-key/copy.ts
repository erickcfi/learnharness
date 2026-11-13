/**
 * The student-facing words for the own AI key (2026-11-13), in one place
 * for the Owner's review: the /account/ai-key page and the messages the
 * meter sends back to the tutor. Plain, short sentences. No em dashes.
 * American English. The legal side (privacy notice, terms) is in Erick's
 * legal drafts, not here.
 */

/** Why a save did not happen. Also the `error` value in the page's address. */
export type SaveProblem = "off" | "format" | "refused" | "no-credit" | "unreachable" | "too-many" | "failed";

export const OWN_KEY_COPY = {
	title: "Your own AI key",
	intro: [
		"The tutor runs on Anthropic's AI. North Aero pays for it, unless you add your own Anthropic API key.",
		"With your own key, Anthropic bills your Anthropic account for your tutor sessions.",
		"What you write in the tutor then goes to Anthropic under your own account.",
		"We store your key encrypted. We show only its last 4 characters. You can remove it at any time.",
	],
	off: "Own AI keys are turned off right now. The tutor uses North Aero's key.",
	offSaved: (last4: string) => `Your key ending in ${last4} is saved, but it is not in use while own keys are off.`,
	usingNorthAero: "The tutor uses North Aero's key now.",
	usingOwn: (last4: string) => `The tutor uses your key ending in ${last4}.`,
	savedOn: (day: string) => `Saved on ${day}.`,
	label: "Anthropic API key",
	help: "It starts with sk-ant-api. We check it with Anthropic before we save it.",
	replaceLabel: "Use a different key",
	save: "Check and save",
	remove: "Remove my key",
	removeHelp: "The tutor goes back to North Aero's key.",
	done: {
		saved: "Saved. The tutor now uses your own key.",
		removed: "Removed. The tutor now uses North Aero's key.",
	},
	problems: {
		off: "Own AI keys are turned off right now. Your key was not saved.",
		format: "That does not look like an Anthropic API key. It starts with sk-ant-api.",
		refused: "Anthropic did not accept that key. Check that you copied all of it.",
		"no-credit": "Anthropic says that key's account has no credit. Add credit with Anthropic, then try again.",
		unreachable: "We could not reach Anthropic to check the key. Try again in a minute.",
		"too-many": "Too many tries. Wait 10 minutes, then try again.",
		failed: "Something went wrong. Your key was not saved. Try again in a minute.",
	} satisfies Record<SaveProblem, string>,
	unavailable: "This page is not available right now. Try again in a minute.",
	back: "Back to studying",
	plans: "Plans and billing",
} as const;

/** What the tutor shows when Anthropic refuses the student's own key (401, 403). No fallback to North Aero's key. */
export const OWN_KEY_REFUSED_MESSAGE = "Anthropic refused your own AI key. Check it on the Account page, or remove it to use North Aero's.";

/** Anthropic says the student's account has no credit (402, or 400 "credit balance is too low"). */
export const OWN_KEY_NO_CREDIT_MESSAGE =
	"Anthropic refused your own AI key because your Anthropic account has no credit. Add credit with Anthropic, or remove the key on the Account page to use North Aero's.";

/** Anthropic is rate-limiting the student's own key (429). */
export const OWN_KEY_LIMITED_MESSAGE =
	"Anthropic refused your own AI key for now: too many requests. Wait a minute and try again, or remove the key on the Account page to use North Aero's.";

/** The saved key cannot be decrypted (the Owner changed LH_OWN_KEY_SECRET). */
export const OWN_KEY_UNREADABLE_MESSAGE = "Your saved AI key can't be read. Save it again on the Account page, or remove it to use North Aero's.";
