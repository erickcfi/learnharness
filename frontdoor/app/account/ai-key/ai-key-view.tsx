import { OWN_KEY_COPY as C, type SaveProblem } from "../../../own-key/copy.ts";
import { OWN_KEY_PATH } from "../../../own-key/paths.ts";
import type { OwnKeyPageState } from "../../../own-key/registry.ts";

/** A line at the top after a form: done, or why not. */
export type Notice = { kind: "done"; text: string } | { kind: "problem"; text: string } | null;

/** The notice for the page's address (?saved=1, ?removed=1, ?error=<problem>). Unknown values show nothing. */
export function noticeFrom(query: Record<string, string | string[] | undefined>): Notice {
	if (query.saved === "1") return { kind: "done", text: C.done.saved };
	if (query.removed === "1") return { kind: "done", text: C.done.removed };
	const error = query.error;
	if (typeof error === "string" && Object.prototype.hasOwnProperty.call(C.problems, error)) return { kind: "problem", text: C.problems[error as SaveProblem] };
	return null;
}

const button = { font: "inherit", fontSize: 16, padding: "10px 18px", borderRadius: 8, border: "1px solid #1a1b1d", background: "#1a1b1d", color: "#fff" } as const;
const quiet = { ...button, background: "#fff", color: "#1a1b1d" } as const;

function day(value: Date, timeZone: string): string {
	return new Date(value).toLocaleDateString("en-US", { timeZone, month: "short", day: "numeric", year: "numeric" });
}

function SaveForm({ label }: { label: string }) {
	return (
		<form method="post" action={OWN_KEY_PATH} style={{ margin: "16px 0" }}>
			<input type="hidden" name="action" value="save" />
			<label htmlFor="own-key" style={{ display: "block", fontSize: 17, marginBottom: 6 }}>
				{label}
			</label>
			<input
				id="own-key"
				name="key"
				type="password"
				autoComplete="off"
				spellCheck={false}
				required
				placeholder="sk-ant-api..."
				style={{ font: "inherit", fontSize: 16, width: "100%", padding: "8px 10px", boxSizing: "border-box" }}
			/>
			<p style={{ fontSize: 14, color: "#555" }}>{C.help}</p>
			<button type="submit" style={button}>
				{C.save}
			</button>
		</form>
	);
}

function RemoveForm() {
	return (
		<form method="post" action={OWN_KEY_PATH} style={{ margin: "16px 0" }}>
			<input type="hidden" name="action" value="remove" />
			<button type="submit" style={quiet}>
				{C.remove}
			</button>
			<p style={{ fontSize: 14, color: "#555" }}>{C.removeHelp}</p>
		</form>
	);
}

/**
 * The /account/ai-key page's body. It gets only what the page may know:
 * on or off, and the saved key's last 4 characters and date.
 */
export function AiKeyView({ state, notice, timeZone }: { state: OwnKeyPageState | "unavailable"; notice: Notice; timeZone: string }) {
	return (
		<main style={{ maxWidth: 560, padding: 16, lineHeight: 1.5 }}>
			<h1 style={{ fontSize: 24 }}>{C.title}</h1>
			{notice && (
				<p role={notice.kind === "problem" ? "alert" : "status"} style={notice.kind === "problem" ? { color: "#9b1c1c" } : undefined}>
					{notice.text}
				</p>
			)}
			{C.intro.map((line) => (
				<p key={line}>{line}</p>
			))}
			{state === "unavailable" ? (
				<p role="alert">{C.unavailable}</p>
			) : !state.enabled ? (
				<>
					<p>
						<strong>{C.off}</strong>
					</p>
					{state.saved && (
						<>
							<p>{C.offSaved(state.saved.last4)}</p>
							<RemoveForm />
						</>
					)}
				</>
			) : state.saved ? (
				<>
					<p>
						<strong>{C.usingOwn(state.saved.last4)}</strong> {C.savedOn(day(state.saved.savedAt, timeZone))}
					</p>
					<RemoveForm />
					<SaveForm label={C.replaceLabel} />
				</>
			) : (
				<>
					<p>
						<strong>{C.usingNorthAero}</strong>
					</p>
					<SaveForm label={C.label} />
				</>
			)}
			<p style={{ marginTop: 24 }}>
				{/* A full page load on purpose: for a signed-in student "/" is the tutor, which Next.js does not serve. */}
				{/* eslint-disable-next-line @next/next/no-html-link-for-pages */}
				<a href="/">{C.back}</a> · <a href="/account/plans">{C.plans}</a>
			</p>
		</main>
	);
}
