/**
 * ALL the text on the public pages: landing page, How it works, Help,
 * legal placeholders, footer, and the sample tutor screens.
 *
 * Erick reviews and edits this file before launch. Rules for the text:
 * plain, short sentences; no em dashes; honest (a study aid, not a CFI or
 * FAA-approved training; AI answers can be wrong; it cites sources; no
 * pass rates, testimonials or made-up numbers).
 *
 * Prices never appear here as numbers. They come from frontdoor/plans
 * (the functions below take the plans and the trial as arguments).
 *
 * Framework-free and runnable by plain Node (type stripping).
 */
import { formatUsd, monthlyEquivalentUsd, trialPlan, type Plan, type Trial } from "../plans/index.ts";
import { CONTACT_EMAIL } from "./site.ts";

export const BRAND = {
	name: "North Aero Ground Tutor",
	school: "North Aero",
	product: "Ground Tutor",
};

export const NAV = {
	howItWorks: "How it works",
	help: "Help",
	signIn: "Sign in",
	startTrial: "Start free trial",
	home: "North Aero Ground Tutor home",
};

export const CTA = {
	startTrial: "Start your free trial",
	seeHow: "See how it works",
	fullTour: "Take the full tour",
};

/** "a month", "every 3 months", "a year". */
export function periodLabel(plan: Plan): string {
	if (plan.months === 1) return "a month";
	if (plan.months === 12) return "a year";
	return `every ${plan.months} months`;
}

/** One plan as it reads on a plan card. */
export function planPriceLine(plan: Plan): { price: string; period: string; note: string | null } {
	return {
		price: formatUsd(plan.priceUsd),
		period: periodLabel(plan),
		note: plan.months > 1 ? `About ${formatUsd(monthlyEquivalentUsd(plan))} a month` : null,
	};
}

/** The trial in one line, under every "Start your free trial" button. */
export function trialSummary(plans: readonly Plan[], trial: Trial): string {
	const after = trialPlan(plans, trial);
	const card = trial.cardRequired ? " Card required." : "";
	return `Free for ${trial.days} days, with up to ${trial.studyHours} hours of study.${card} Then ${formatUsd(after.priceUsd)} ${periodLabel(after)} until you cancel.`;
}

export const LANDING = {
	meta: {
		title: "North Aero Ground Tutor: AI ground school for pilots",
		description: (trial: Trial) =>
			`An AI ground instructor from North Aero. It finds what you know, builds a plan, teaches one step at a time, and drills you. Try it free for ${trial.days} days.`,
	},
	hero: {
		eyebrow: "Ground school from North Aero",
		titleLines: ["Ground school that", "starts where you are."],
		lead: "The Ground Tutor is an AI ground instructor. It checks what you already know, builds a plan, teaches you one step at a time, and drills you until it sticks. It works from North Aero's library of FAA, NTSB and POH sources.",
	},
	tour: {
		eyebrow: "How it works",
		title: "Measure. Plan. Teach. Practice.",
		lead: "Every session follows the same method. Here is what it looks like on screen.",
	},
	audience: {
		eyebrow: "Who it's for",
		title: "For pilots who want to know why",
		items: [
			{
				title: "Student pilots",
				text: "Working toward a sport or private certificate. Get ready for the knowledge test and the oral part of your checkride.",
			},
			{
				title: "Rated pilots",
				text: "Adding an instrument or commercial rating, getting ready for a flight review, or moving to a new airplane.",
			},
		],
		age: "You must be 18 or older to sign up.",
	},
	library: {
		eyebrow: "The library",
		title: "Built on sources you can check",
		text: "The tutor works from a library North Aero puts together. It can also search the web. It tells you where its answers come from, so you can check them.",
		sources: [
			{ title: "FAA handbooks and regulations", text: "The handbooks, advisory circulars and rules you are tested on." },
			{ title: "NTSB accident reports", text: "Real accidents and what caused them, the way we teach at North Aero." },
			{ title: "POH data", text: "Numbers and systems for the airplanes we fly." },
		],
	},
	honest: {
		eyebrow: "Straight talk",
		title: "What it is, and what it isn't",
		isTitle: "It is",
		is: [
			"A study aid for ground knowledge.",
			"A way to find and fix weak spots before your checkride.",
			"There any time, on your phone or your computer.",
		],
		isntTitle: "It isn't",
		isnt: [
			"A replacement for your CFI. Your instructor signs you off, not the tutor.",
			"FAA-approved training. It does not log time or give endorsements.",
			"Always right. Answers come from AI and can be wrong. Check anything important against the source it cites.",
		],
	},
	pricing: {
		eyebrow: "Pricing",
		title: "One tutor. Three ways to pay.",
		trialTitle: (trial: Trial) => `Start with a free ${trial.days}-day trial`,
		trialText: (plans: readonly Plan[], trial: Trial) => {
			const after = trialPlan(plans, trial);
			const card = trial.cardRequired ? "You need a card to start. " : "";
			return `${card}The trial includes up to ${trial.studyHours} hours of study. If you do nothing, the ${after.name.toLowerCase()} plan starts on day ${trial.days}.`;
		},
		renewNote: "All plans renew automatically until you cancel. Cancel any time.",
		studentCode: "Training at North Aero? Ask us for the student discount code.",
	},
	final: {
		title: "Ready to study?",
		text: "Sign up in a minute. Your first session can start today.",
	},
};

/** The five screens of the tour, used on the landing page. */
export const TOUR_TABS = [
	{ id: "probe", tab: "Measure", title: "It finds where your knowledge ends", text: "Before it teaches, the tutor asks questions. Your answer, how sure you are, and your thinking tell it where to start." },
	{ id: "plan", tab: "Plan", title: "It builds your plan", text: "It maps the topics between what you know and your goal. It skips what you already know." },
	{ id: "teach", tab: "Teach", title: "One step, then a check", text: "Each step builds on something you already know. A question checks that it landed before the tutor goes on." },
	{ id: "practice", tab: "Practice", title: "It drills you", text: "Practice sessions give you real problems, with hints when you need them." },
	{ id: "record", tab: "Record", title: "A record for your CFI", text: "Every session goes into a study record you can print or email." },
] as const;

export type ScreenId = "ask" | (typeof TOUR_TABS)[number]["id"];

export const HOW_IT_WORKS = {
	meta: {
		title: "How it works",
		description: "A step-by-step tour of a study session with the North Aero Ground Tutor: it measures what you know, plans, teaches, drills you, and keeps a record.",
	},
	eyebrow: "How it works",
	title: "A tour of a study session",
	lead: "This is how a session with the Ground Tutor goes, step by step. The screens are simplified. The steps are the real ones.",
	replay: "Replay",
	steps: [
		{
			id: "ask",
			kicker: "Step 1",
			title: "Say what you want to learn",
			text: [
				"Type a topic or a question, for example \"Teach me to decode a METAR.\"",
				"Choose Teach for a lesson, or Practice for problems.",
			],
		},
		{
			id: "probe",
			kicker: "Step 2. Measure",
			title: "It finds where your knowledge ends",
			text: [
				"The tutor opens with questions. Pick an answer, or choose I don't know. Guessing only hides what you need.",
				"Set how sure you are, and type your thinking. That tells the tutor more than right or wrong.",
			],
		},
		{
			id: "plan",
			kicker: "Step 3. Plan",
			title: "It maps the route to your goal",
			text: [
				"From your answers, it builds a plan of topics, from what you know to your goal. It skips what you already know.",
				"You can open the full plan any time. Reply in your own words if you want to change it.",
			],
		},
		{
			id: "teach",
			kicker: "Step 4. Teach",
			title: "One step, then a check",
			text: [
				"Each explanation is one small step that builds on what you know. A question follows to check that it landed.",
				"If it did not land, the tutor fixes that before it goes on. It cites its sources, so you can check them.",
			],
		},
		{
			id: "practice",
			kicker: "Step 5. Practice",
			title: "Problems that make you use it",
			text: [
				"Start a Practice session for real problems. Work each one out and think out loud.",
				"Ask for a hint when you are stuck. Then go on to the next problem.",
			],
		},
		{
			id: "record",
			kicker: "Step 6. Record",
			title: "A record for your CFI",
			text: [
				"Your sessions, topics and study time go into a study record. Print it, or email it to your CFI.",
				"It is a self-study record. It is not a logbook entry or an instructor endorsement.",
			],
		},
	] satisfies { id: ScreenId; kicker: string; title: string; text: string[] }[],
	memory: {
		title: "It remembers what you learned",
		text: "What you learn is saved as facts and the links between them. Your next session builds on it instead of starting over. You can add your own notes too.",
	},
};

export const HELP = {
	meta: {
		title: "Help",
		description: "Getting started with the North Aero Ground Tutor: start a session, answer the tutor, practice, import notes, print your record, and manage your plan.",
	},
	eyebrow: "Help",
	title: "Getting started",
	lead: "Short steps for your first sessions. Questions we have not answered here? Email us.",
	sections: [
		{
			id: "start",
			title: "Start a session",
			steps: [
				"Sign in.",
				"Type what you want to learn in the box, for example \"Teach me VOR navigation.\"",
				"Choose Teach, then press Enter. The tutor starts by asking what you already know.",
			],
		},
		{
			id: "answer",
			title: "Answer the tutor",
			steps: [
				"Pick an answer, or choose I don't know. Guessing hides what you need to learn.",
				"Set your confidence. Be honest. It helps the tutor.",
				"Use Your thinking to say why. A sentence or two is enough.",
				"You can reply in your own words at any time, for example to change the plan.",
			],
		},
		{
			id: "practice",
			title: "Use practice",
			steps: [
				"On the home screen, choose Practice.",
				"Say what to practice, or pick facts you have already learned.",
				"Work the problem and think out loud. Ask for a hint when you are stuck.",
				"Choose Next problem when you are ready.",
			],
		},
		{
			id: "notes",
			title: "Import your own notes",
			steps: [
				"On the home screen, choose Import notes.",
				"Pick Markdown, text or PDF files, up to 20 MB each.",
				"The tutor turns them into facts it can teach from and quiz you on.",
			],
			note: "PDF pages that are only pictures, like some scans, are skipped. Imports count toward your use of the tutor.",
		},
		{
			id: "record",
			title: "Print or email your record",
			steps: [
				"Open your study record.",
				"Pick the dates you want.",
				"Choose Print, or email it to any address, such as your CFI's.",
			],
			note: "You can also turn on email reports, after each session or once a week.",
		},
		{
			id: "billing",
			title: "Cancel or change your card",
			steps: [
				"Open your account, then Manage billing.",
				"Change your card, or cancel your plan.",
				"If you cancel, you keep the tutor until the end of the time you paid for.",
			],
			note: "We keep your data for 90 days after that, so you can export it. Then it is deleted.",
		},
	],
	faqTitle: "Questions and answers",
	faq: (plans: readonly Plan[], trial: Trial): { q: string; a: string[] }[] => {
		const after = trialPlan(plans, trial);
		return [
			{
				q: "What is the Ground Tutor?",
				a: [
					"An AI ground instructor from North Aero. It finds what you know, makes a plan, teaches you, and drills you on ground knowledge. It works from North Aero's library of FAA, NTSB and POH sources.",
				],
			},
			{
				q: "Does it replace my CFI or ground school?",
				a: [
					"No. It is a study aid. It is not FAA-approved training. It cannot sign you off, log time, or give endorsements. Use it alongside your instructor.",
				],
			},
			{
				q: "Can the tutor be wrong?",
				a: ["Yes. Answers come from AI and can be wrong. The tutor cites its sources. Check anything important against the source, and ask your CFI."],
			},
			{
				q: "How does the free trial work?",
				a: [
					`The trial lasts ${trial.days} days and includes up to ${trial.studyHours} hours of study.${trial.cardRequired ? " You need a card to start." : ""} There is one trial per person and per card.`,
					`If you do nothing, the ${after.name.toLowerCase()} plan starts on day ${trial.days}, at ${formatUsd(after.priceUsd)} ${periodLabel(after)}.`,
					"If you use up your study hours early, the tutor stops new lessons, but you can still read all your sessions and records. Choose Buy now to start a plan right away. That ends the trial.",
				],
			},
			{
				q: "How much does it cost?",
				a: [
					plans.map((plan) => `${plan.name}: ${formatUsd(plan.priceUsd)} ${periodLabel(plan)}.`).join(" "),
					"All plans renew automatically until you cancel.",
				],
			},
			{
				q: "Is there a discount for North Aero students?",
				a: ["Yes. If you train at North Aero, ask us for the student code. Enter it when you pay."],
			},
			{
				q: "Who can see my sessions?",
				a: [
					"North Aero can see how much you use the tutor and which topics you study. We see what you write only if you choose to share it. The privacy policy has the details.",
				],
			},
			{
				q: "Where does my data go?",
				a: [
					"Your study data is stored on North Aero's service in the United States. To answer you, the tutor sends your messages to its AI provider, Anthropic. Web searches go through a search service.",
				],
			},
			{
				q: "Why does my tutor say it is paused?",
				a: [
					"Very heavy use can pause the tutor under the fair-use limit in the terms. Your sessions and records stay available. Email us and we will sort it out.",
				],
			},
			{
				q: "What happens to my data if I cancel?",
				a: ["We keep it for 90 days after your plan ends, so you can export it. Then it is deleted."],
			},
			{
				q: "Who do I contact?",
				a: [`Email ${CONTACT_EMAIL}. We are North Aero, a flight school at the Salinas Airport (KSNS) in California.`],
			},
		];
	},
};

export const LEGAL = {
	terms: { title: "Terms of service" },
	privacy: { title: "Privacy policy" },
	aiNotice: { title: "AI notice" },
	comingSoon: "Coming soon.",
	question: `Questions? Email ${CONTACT_EMAIL}.`,
};

export const FOOTER = {
	tagline: "A North Aero service. Salinas, California.",
	disclaimer: "A study aid, not FAA-approved training. Answers come from AI and can be wrong.",
	terms: "Terms",
	privacy: "Privacy",
	aiNotice: "AI notice",
	builtOn: "Built on LearnHarness, open source under the AGPL-3.0 license.",
	contact: "Contact",
	copyright: (year: number) => `© ${year} North Aero, Inc.`,
};

/**
 * The sample tutor screens. Labels match the real tutor (upstream
 * LearnHarness components); the aviation content is a sample lesson.
 */
export const SCREENS = {
	sessionTitle: "Decoding a METAR",
	ask: {
		title: "New session",
		prompt: "What do you want to learn?",
		typed: "Teach me to decode a METAR",
		teach: "Teach",
		practice: "Practice",
		hint: "The teacher will open by probing what you already know.",
		start: "Start session",
	},
	probe: {
		phase: "Probing",
		kind: "Probe",
		question: "In the time group 081853Z, what does the Z mean?",
		options: ["The time is local time at the airport", "The time is Zulu time (UTC)", "The report was corrected after it was sent"],
		correct: 1,
		dontKnow: "I don't know",
		confidenceLabel: "Confidence",
		confidence: 70,
		thinkingLabel: "Your thinking",
		thinking: "Pretty sure it's Zulu. Same as on my flight plan.",
		submit: "Submit answer",
	},
	plan: {
		phase: "Planning",
		intro: "You already read the station and time. We start at wind.",
		divider: "Plan · 6 nodes",
		nodes: ["Station and time", "Wind", "Visibility and weather", "Clouds and ceiling", "Temperature and altimeter", "Decode a full METAR"],
		open: "Open the full plan",
	},
	teach: {
		phase: "Teaching",
		lines: [
			"The wind group comes right after the time.",
			"In 31012KT, the first three digits are the direction the wind blows from, in degrees true. The last two are its speed in knots.",
			"A G adds gusts. 31012G20KT means 12 knots, gusting to 20.",
		],
		source: "Source: AC 00-45H, Aviation Weather Services",
		kind: "Check",
		question: "Decode 24008G15KT.",
		options: ["From 240° true at 8 knots, gusting to 15", "Toward 240° true at 8 knots, gusting to 15", "From 240° magnetic at 15 knots, gusting to 8"],
		correct: 0,
		submit: "Submit answer",
	},
	practice: {
		title: "Practice: METARs",
		problemLabel: "Problem 3",
		problem: "Salinas reports:",
		metar: "KSNS 081853Z 29015G22KT 2SM BR OVC006 14/12 A2998",
		ask: "You want to take off VFR from Salinas, in Class D airspace. Can you go?",
		workLabel: "Your thinking",
		placeholder: "Work here, think out loud.",
		work: "Ceiling 600 overcast, visibility 2 miles. Class D needs a 1,000 foot ceiling and 3 miles. So no, not without a special VFR clearance.",
		reply: "Right. Both are below the basic VFR minimums in 14 CFR 91.155.",
		outcome: "Solved",
		next: "Next problem",
	},
	record: {
		title: "Study record",
		label: "Self-study record. Not a logbook entry or instructor endorsement.",
		student: "Sample Student",
		range: "Last 7 days",
		sessions: [
			{
				title: "Decoding a METAR",
				time: "42 min",
				topics: [
					{ name: "Station and time", status: "Covered" },
					{ name: "Wind", status: "Covered" },
					{ name: "Visibility and weather", status: "Covered" },
					{ name: "Clouds and ceiling", status: "In progress" },
					{ name: "Temperature and altimeter", status: "Not yet" },
				],
			},
			{
				title: "Class D airspace",
				time: "25 min",
				topics: [
					{ name: "Dimensions and charting", status: "Covered" },
					{ name: "Two-way radio contact", status: "Covered" },
				],
			},
		],
		total: "2 sessions · 1 h 7 min",
		print: "Print",
		email: "Email to my CFI",
	},
};
