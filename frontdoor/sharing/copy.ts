/**
 * The student-facing words on /account/sharing, in one place for the
 * Owner's review (they must match the landing page FAQ: "We see what you
 * write only if you choose to share it", and the privacy policy, D19).
 */
export const SHARING_COPY = {
	title: "Sharing your session text",
	intro: [
		"North Aero sees your study time, how many sessions you have had, and the titles of the topics you study. We use these to run the service.",
		"We read what you write in your sessions only if you turn this on.",
	],
	label: "Let North Aero read my session text",
	help: "Off unless you turn it on. You can turn it off at any time, and it stops at once. We keep the dates you turn it on and off.",
	save: "Save",
	savedOn: "Saved. North Aero can now read your session text.",
	savedOff: "Saved. North Aero cannot read your session text.",
	back: "Back to studying",
} as const;
