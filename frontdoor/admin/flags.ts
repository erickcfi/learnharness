/**
 * The non-aviation flag (P3-05, C7 req 4, N7).
 *
 * After each session (a chat with no active time for 30 minutes,
 * study-time/queries.ts), claude-haiku-5-5 labels the session's topic as
 * aviation or not. It sees only the session title and the plan's topic
 * titles, never session text. The label is stored in topic_labels and shown
 * on the dashboard. It has no effect on the tutor.
 *
 * The call goes straight to Anthropic with the front door's own key: the
 * student did not cause it, so it is not metered to the student.
 *
 * A chat the tenant server does not have (deleted, or never saved) gets a
 * row with no label (is_aviation null, model CHAT_NOT_FOUND), so the sweep
 * stops asking for it until it is studied again (master, 2026-11-10).
 */
import { type Db, getTopicLabel, saveTopicLabel } from "../db/index.ts";
import { errorLabel } from "../log-hygiene/filter.ts";
import { listEndedSessions } from "../study-time/queries.ts";
import { fetchSessionTopics, type TenantFetch, TenantReadError } from "./tenant-api.ts";

export const FLAG_MODEL = "claude-haiku-5-5";

/** topic_labels.model for a chat the tenant server answered 404 for: no label was made. */
export const CHAT_NOT_FOUND = "none: chat not found";

export const FLAG_SYSTEM_PROMPT =
	"You sort study topics for a flight school's ground tutor. Reply with one word: aviation or other. " +
	"Aviation covers flying, aircraft and their systems, aerodynamics, weather for pilots, navigation, airspace, FAA rules, and pilot health and human factors.";

export interface SessionTopic {
	title: string;
	topics: string[];
}

export function flagUserPrompt(topic: SessionTopic): string {
	const lines = [`Session title: ${topic.title.slice(0, 300)}`];
	if (topic.topics.length > 0) {
		lines.push("Plan topics:");
		for (const t of topic.topics.slice(0, 40)) lines.push(`- ${t.slice(0, 200)}`);
	}
	return lines.join("\n");
}

export interface TopicClassifier {
	readonly model: string;
	/** "aviation", "other", or null when the answer was unclear (tried again later). */
	classify(topic: SessionTopic): Promise<"aviation" | "other" | null>;
}

/** Haiku through Anthropic's Messages API. */
export function haikuClassifier(options: { apiKey: string; baseUrl?: string; fetchImpl?: typeof fetch; model?: string }): TopicClassifier {
	const model = options.model ?? FLAG_MODEL;
	const base = (options.baseUrl ?? "https://api.anthropic.com").replace(/\/+$/, "");
	const fetchImpl = options.fetchImpl ?? fetch;
	return {
		model,
		async classify(topic) {
			const res = await fetchImpl(`${base}/v1/messages`, {
				method: "POST",
				headers: { "content-type": "application/json", "x-api-key": options.apiKey, "anthropic-version": "2023-06-01" },
				body: JSON.stringify({
					model,
					max_tokens: 5,
					temperature: 0,
					system: FLAG_SYSTEM_PROMPT,
					messages: [{ role: "user", content: flagUserPrompt(topic) }],
				}),
				signal: AbortSignal.timeout(20_000),
			});
			if (!res.ok) throw new Error(`labeling call answered ${res.status}`);
			const body = (await res.json()) as { content?: Array<{ type: string; text?: string }> };
			const text = (body.content ?? [])
				.filter((c) => c.type === "text")
				.map((c) => c.text ?? "")
				.join("")
				.trim()
				.toLowerCase()
				.replace(/[^a-z]/g, "");
			if (text === "aviation") return "aviation";
			if (text === "other") return "other";
			return null;
		},
	};
}

/** How the topic is stored in topic_labels.topic: "Title | topic; topic". */
export function storedTopic(topic: SessionTopic): string {
	const tail = topic.topics.length > 0 ? ` | ${topic.topics.join("; ")}` : "";
	return `${topic.title}${tail}`.slice(0, 1000);
}

export interface LabelRun {
	/** New labels: Haiku was asked. */
	labeled: number;
	nonAviation: number;
	/** Studied again with the same title and plan topics: the old label stands, no call. */
	unchanged: number;
	/** The tenant server has no such chat: stored with no label, not asked for again until studied again. */
	missing: number;
	/** Could not finish (unclear answer, server down): tried again at the next sweep. */
	skipped: number;
}

/**
 * Label every ended session studied since its last label. Each chat is
 * labeled once, and again only when its title or plan topics have changed
 * (master decision, 2026-11-08); otherwise the old label is kept and only
 * its date moves, so the chat is not checked again until it is studied again.
 */
export async function labelEndedSessions(deps: {
	db: Db;
	tenantFetch: TenantFetch;
	classifier: TopicClassifier;
	now?: () => Date;
	log?: (line: string) => void;
	limit?: number;
}): Promise<LabelRun> {
	const now = deps.now ? deps.now() : new Date();
	const ended = await listEndedSessions(deps.db, { now, unlabeledOnly: true, limit: deps.limit ?? 50 });
	const run: LabelRun = { labeled: 0, nonAviation: 0, unchanged: 0, missing: 0, skipped: 0 };
	for (const session of ended) {
		try {
			let topic: SessionTopic;
			try {
				topic = await fetchSessionTopics(deps.tenantFetch, session.tenantId, session.chatId);
			} catch (error) {
				if (!(error instanceof TenantReadError && error.status === 404)) throw error;
				// No such chat on the tenant server. Without a row the sweep would
				// ask for it every 5 minutes forever, and 50 of them would fill
				// every sweep and stop labeling for all students.
				await saveTopicLabel(deps.db, { tenantId: session.tenantId, chatId: session.chatId, topic: "", isAviation: null, model: CHAT_NOT_FOUND, at: now });
				run.missing += 1;
				deps.log?.(`non-aviation label for tenant ${session.tenantId} chat ${session.chatId} not made: the tenant server has no such chat; not asked for again unless it is studied again`);
				continue;
			}
			const previous = await getTopicLabel(deps.db, session.tenantId, session.chatId);
			if (previous && previous.isAviation !== null && previous.topic === storedTopic(topic)) {
				await saveTopicLabel(deps.db, { tenantId: session.tenantId, chatId: session.chatId, topic: previous.topic, isAviation: previous.isAviation, model: previous.model, at: now });
				run.unchanged += 1;
				continue;
			}
			const label = await deps.classifier.classify(topic);
			if (!label) {
				run.skipped += 1;
				continue;
			}
			await saveTopicLabel(deps.db, {
				tenantId: session.tenantId,
				chatId: session.chatId,
				topic: storedTopic(topic),
				isAviation: label === "aviation",
				model: deps.classifier.model,
				at: now,
			});
			run.labeled += 1;
			if (label === "other") run.nonAviation += 1;
		} catch (error) {
			run.skipped += 1;
			// Tenant and chat ids only: never a title or topic (cross-cutting req 3).
			deps.log?.(`non-aviation label for tenant ${session.tenantId} chat ${session.chatId} not made (${errorLabel(error)})`);
		}
	}
	return run;
}

/** Runs labelEndedSessions every `intervalMs` (default 5 minutes). Returns stop(). */
export function startFlagSweeper(deps: Parameters<typeof labelEndedSessions>[0] & { intervalMs?: number }): () => Promise<void> {
	let running: Promise<unknown> | null = null;
	const tick = () => {
		if (running) return;
		running = labelEndedSessions(deps)
			.catch((error: unknown) => deps.log?.(`non-aviation sweep failed (${errorLabel(error)})`))
			.finally(() => {
				running = null;
			});
	};
	const timer = setInterval(tick, deps.intervalMs ?? 5 * 60_000);
	timer.unref();
	return async () => {
		clearInterval(timer);
		await running;
	};
}
