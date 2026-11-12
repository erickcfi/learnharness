import Link from "next/link";
import { notFound } from "next/navigation";
import { parsePeriod, PERIOD_LABELS, PERIODS } from "../../../../admin/period.ts";
import { Flash } from "../../_components/flash.tsx";
import { PauseButton } from "../../_components/pause-button.tsx";
import { ALERT_LABELS, BILLING_PENDING, CONVERSION_LABELS, day, dayTime, duration, hours, PLAN_LABELS, STATUS_LABELS, usd } from "../../_lib/format.ts";
import { param, requireAdmin } from "../../_lib/guard.ts";

/**
 * One student (C7 req 2 and 3): numbers, sessions with topics and the
 * non-aviation flag, consent, alerts and pauses. Session text links appear
 * only when a consent is active (D19); the text page checks again.
 */
export default async function StudentPage({
	params,
	searchParams,
}: {
	params: Promise<{ tenantId: string }>;
	searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
	const { rt } = await requireAdmin();
	const { tenantId } = await params;
	const q = await searchParams;
	const period = parsePeriod(param(q.period));
	const d = await rt.student(tenantId, period);
	if (!d) notFound();
	const r = d.row;
	const tz = rt.timeZone;
	const back = `/admin/students/${tenantId}?period=${period}`;
	const optIn = d.consent.history.filter((c) => c.kind === "session_text_opt_in").at(-1);
	const tester = d.consent.history.filter((c) => c.kind === "tester_written_ok").at(-1);

	return (
		<>
			<Flash done={param(q.done)} error={param(q.error)} />
			<p className="dash-muted">
				<Link href="/admin">← Students</Link>
			</p>
			<h1>{r.name ?? r.email ?? `Student ${r.shortId}`}</h1>
			<div className="dash-row">
				<span className={`dash-badge ${r.status}`}>{STATUS_LABELS[r.status]}</span>
				{r.roles.includes("owner") && <span className="dash-badge">Owner</span>}
				{r.alerts.map((k) => (
					<span key={k} className="dash-badge alert">
						{ALERT_LABELS[k]}
					</span>
				))}
				{r.name && r.email && <span className="dash-muted">{r.email}</span>}
			</div>
			<div className="dash-actions">
				<PauseButton tenantId={tenantId} paused={r.paused} back={back} name={r.name ?? r.email ?? `Student ${r.shortId}`} />
			</div>

			<nav className="dash-tabs" aria-label="Period" style={{ marginTop: 16 }}>
				{PERIODS.map((p) => (
					<Link key={p} href={`/admin/students/${tenantId}?period=${p}`} aria-current={p === period ? "page" : undefined}>
						{PERIOD_LABELS[p]}
					</Link>
				))}
			</nav>
			<div className="dash-card">
				<dl className="dash-dl">
					<div>
						<dt>Model cost</dt>
						<dd>{usd(r.modelCostUsd)}</dd>
					</div>
					<div>
						<dt>Search fees</dt>
						<dd>
							{usd(r.searchFeeUsd)} ({r.searchCount})
						</dd>
					</div>
					<div>
						<dt>Model calls</dt>
						<dd>{r.modelCalls}</dd>
					</div>
					<div>
						<dt>Unpriced calls</dt>
						<dd>{r.unpricedCalls}</dd>
					</div>
					<div>
						<dt>Study time</dt>
						<dd>{hours(r.studySeconds)}</dd>
					</div>
					<div>
						<dt>Sessions</dt>
						<dd>{r.sessions}</dd>
					</div>
					<div>
						<dt>Plan</dt>
						<dd>{r.plan ? PLAN_LABELS[r.plan] : "–"}</dd>
					</div>
					<div>
						<dt>Coupon</dt>
						<dd>{r.coupon ?? "–"}</dd>
					</div>
					<div>
						<dt>Revenue</dt>
						<dd>{usd(r.revenueUsd)}</dd>
					</div>
					<div>
						<dt>Conversion</dt>
						<dd>{CONVERSION_LABELS[r.conversion]}</dd>
					</div>
				</dl>
				{r.plan === null && r.revenueUsd === 0 && <p className="dash-note">Plan, coupon and revenue: {BILLING_PENDING.toLowerCase()}, or no plan yet.</p>}
			</div>

			<h2>Sessions ({d.sessions.length})</h2>
			{d.sessionsError && <p className="dash-flash err">{d.sessionsError}</p>}
			{d.sessions.length === 0 && <p className="dash-muted">No sessions yet.</p>}
			{d.sessions.map((s) => (
				<div className="dash-card" key={s.chatId}>
					<div className="dash-row">
						<strong>{s.title ?? "Untitled session"}</strong>
						{s.isAviation === false && <span className="dash-badge flag">Not aviation</span>}
						{s.isAviation === true && <span className="dash-badge ok">Aviation</span>}
					</div>
					<div className="dash-muted">
						{day(s.createdAt ?? s.lastActiveAt, tz)} · {duration(s.activeSeconds)} studied
						{s.lastActiveAt ? ` · last active ${dayTime(s.lastActiveAt, tz)}` : ""}
					</div>
					{s.topics && s.topics.length > 0 && <p className="dash-note">Topics: {s.topics.join(" · ")}</p>}
					{d.canShowText && (
						<div className="dash-actions">
							<Link className="dash-btn" href={`/admin/students/${tenantId}/sessions/${encodeURIComponent(s.chatId)}`}>
								Read session text
							</Link>
						</div>
					)}
				</div>
			))}

			<h2>Session text consent</h2>
			<div className="dash-card">
				<p>
					{d.canShowText
						? "You can read this student's session text."
						: "You cannot read this student's session text. You see only titles, topics and numbers."}
				</p>
				<ul className="dash-list">
					<li>
						Student's own opt-in:{" "}
						<strong>{d.consent.optedIn ? `on since ${day(optIn?.grantedAt ?? null, tz)}` : optIn?.revokedAt ? `off since ${day(optIn.revokedAt, tz)}` : "off"}</strong>
					</li>
					<li>
						Tester's written OK:{" "}
						<strong>
							{d.consent.testerWrittenOk ? `recorded ${day(tester?.grantedAt ?? null, tz)}${tester?.note ? ` (${tester.note})` : ""}` : "none"}
						</strong>
					</li>
				</ul>
				{d.consent.testerWrittenOk ? (
					<form method="post" action={`/admin/api/tenants/${tenantId}/consents/tester/revoke`} className="dash-actions">
						<input type="hidden" name="back" value={back} />
						<button type="submit">Revoke tester's written OK</button>
					</form>
				) : (
					<form method="post" action={`/admin/api/tenants/${tenantId}/consents/tester`}>
						<input type="hidden" name="back" value={back} />
						<label htmlFor="note">Record a tester's written OK. Where is it kept?</label>
						<input id="note" name="note" type="text" maxLength={300} placeholder="Signed form, 2026-11-10" required />
						<div className="dash-actions">
							<button type="submit">Record written OK</button>
						</div>
					</form>
				)}
			</div>

			{(d.alerts.length > 0 || d.pauses.length > 0) && (
				<>
					<h2>History</h2>
					<ul className="dash-list">
						{d.alerts.map((a) => (
							<li key={`a${a.id}`}>
								{ALERT_LABELS[a.kind]} {dayTime(a.createdAt, tz)}: {usd(a.windowCostUsd)} in 30 days (line {usd(a.thresholdUsd)})
								{a.clearedAt ? `, cleared ${dayTime(a.clearedAt, tz)}` : ", open"}
							</li>
						))}
						{d.pauses.map((p) => (
							<li key={`p${p.id}`}>
								Paused {dayTime(p.pausedAt, tz)} ({p.reason === "owner" ? "by you" : "autopause"})
								{p.unpausedAt ? `, unpaused ${dayTime(p.unpausedAt, tz)}` : ", still paused"}
							</li>
						))}
					</ul>
				</>
			)}
		</>
	);
}
