import Link from "next/link";
import type { Overview, TenantRow } from "../../admin/overview.ts";
import { parsePeriod, PERIOD_LABELS, PERIODS } from "../../admin/period.ts";
import { Flash } from "./_components/flash.tsx";
import { PauseButton } from "./_components/pause-button.tsx";
import { ALERT_LABELS, BILLING_PENDING, CONVERSION_LABELS, hours, PLAN_LABELS, STATUS_LABELS, usd } from "./_lib/format.ts";
import { param, requireAdmin } from "./_lib/guard.ts";

/** The dashboard's first page (C7 req 2): totals, open alerts, one card per student. */
export default async function AdminHome({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
	const { rt } = await requireAdmin();
	const q = await searchParams;
	const period = parsePeriod(param(q.period));
	const o = await rt.overview(period);
	const back = `/admin?period=${period}`;
	const names = new Map(o.rows.map((r) => [r.tenantId, r]));

	return (
		<>
			<Flash done={param(q.done)} error={param(q.error)} />
			<h1>Students</h1>
			<nav className="dash-tabs" aria-label="Period">
				{PERIODS.map((p) => (
					<Link key={p} href={`/admin?period=${p}`} aria-current={p === period ? "page" : undefined}>
						{PERIOD_LABELS[p]}
					</Link>
				))}
			</nav>
			<Totals o={o} />
			{!o.billingConnected && <p className="dash-note">Plan, coupon, revenue and conversion show here after billing is connected.</p>}

			{o.openAlerts.length > 0 && (
				<>
					<h2>Open alerts ({o.openAlerts.length})</h2>
					{o.openAlerts.map((a) => {
						const row = names.get(a.tenantId);
						return (
							<div className="dash-card alert" key={a.id}>
								<div className="dash-row">
									<span className="dash-badge alert">{ALERT_LABELS[a.kind]}</span>
									<Link className="dash-name" href={`/admin/students/${a.tenantId}`}>
										{row ? displayName(row) : a.tenantId.slice(0, 8)}
									</Link>
								</div>
								<p className="dash-muted">
									{usd(a.windowCostUsd)} of model cost in 30 days passed the {usd(a.thresholdUsd)} line.
								</p>
								<div className="dash-actions">
									{row && <PauseButton tenantId={a.tenantId} paused={row.paused} back={back} name={displayName(row)} />}
									<form method="post" action={`/admin/api/alerts/${a.id}/clear`}>
										<input type="hidden" name="back" value={back} />
										<button type="submit">Clear alert</button>
									</form>
								</div>
							</div>
						);
					})}
				</>
			)}

			<h2>
				{o.rows.length} {o.rows.length === 1 ? "student" : "students"}
			</h2>
			{o.rows.length === 0 && <p className="dash-muted">No one has signed up yet.</p>}
			<div className="dash-grid">
				{o.rows.map((r) => (
					<StudentCard key={r.tenantId} r={r} billing={o.billingConnected} back={back} />
				))}
			</div>
			<p className="dash-note">
				{PERIOD_LABELS[period]}. Cost is model cost plus web search fees. Dates are Salinas time.
			</p>
		</>
	);
}

function displayName(r: TenantRow): string {
	return r.name ?? r.email ?? `Student ${r.shortId}`;
}

function Totals({ o }: { o: Overview }) {
	const t = o.totals;
	return (
		<div className="dash-stats">
			<div className="dash-stat">
				<b>{t.students}</b>
				<span>
					{t.byStatus.trial} trial · {t.byStatus.active} active · {t.byStatus.paused} paused
				</span>
			</div>
			<div className="dash-stat">
				<b>{usd(t.costUsd)}</b>
				<span>
					Cost ({usd(t.modelCostUsd)} model, {usd(t.searchFeeUsd)} search)
				</span>
			</div>
			<div className="dash-stat">
				<b>{o.billingConnected ? usd(t.revenueUsd) : "–"}</b>
				<span>{o.billingConnected ? `Revenue · margin ${usd(t.marginUsd)}` : `Revenue: ${BILLING_PENDING.toLowerCase()}`}</span>
			</div>
			<div className="dash-stat">
				<b>{o.billingConnected && t.conversionRate !== null ? `${Math.round(t.conversionRate * 100)}%` : "–"}</b>
				<span>{o.billingConnected ? `Trial to paid (${t.converted} of ${t.trialsEnded})` : `Conversion: ${BILLING_PENDING.toLowerCase()}`}</span>
			</div>
			<div className="dash-stat">
				<b>{hours(t.studySeconds)}</b>
				<span>Study time · {t.sessions} sessions</span>
			</div>
			<div className="dash-stat">
				<b>{t.searchCount}</b>
				<span>Web searches</span>
			</div>
			<div className="dash-stat">
				<b>{t.nonAviationSessions}</b>
				<span>Non-aviation sessions</span>
			</div>
			<div className="dash-stat">
				<b>{t.unpricedCalls}</b>
				<span>Unpriced model calls</span>
			</div>
		</div>
	);
}

function StudentCard({ r, billing, back }: { r: TenantRow; billing: boolean; back: string }) {
	return (
		<div className={`dash-card${r.alerts.length ? " alert" : ""}`}>
			<div className="dash-row">
				<Link className="dash-name" href={`/admin/students/${r.tenantId}`}>
					{displayName(r)}
				</Link>
				<span className={`dash-badge ${r.status}`}>{STATUS_LABELS[r.status]}</span>
				{r.roles.includes("owner") && <span className="dash-badge">Owner</span>}
				{r.alerts.map((k) => (
					<span key={k} className="dash-badge alert">
						{ALERT_LABELS[k]}
					</span>
				))}
				{r.nonAviationSessions > 0 && <span className="dash-badge flag">{r.nonAviationSessions} non-aviation</span>}
			</div>
			{r.name && r.email && <div className="dash-muted">{r.email}</div>}
			<dl className="dash-dl">
				<div>
					<dt>Cost</dt>
					<dd>{usd(r.costUsd)}</dd>
				</div>
				<div>
					<dt>Revenue</dt>
					<dd>{billing ? usd(r.revenueUsd) : "–"}</dd>
				</div>
				<div>
					<dt>Study</dt>
					<dd>{hours(r.studySeconds)}</dd>
				</div>
				<div>
					<dt>Sessions</dt>
					<dd>{r.sessions}</dd>
				</div>
				<div>
					<dt>Plan</dt>
					<dd>{billing ? (r.plan ? PLAN_LABELS[r.plan] : "–") : "–"}</dd>
				</div>
				<div>
					<dt>Coupon</dt>
					<dd>{billing ? (r.coupon ?? "–") : "–"}</dd>
				</div>
				<div>
					<dt>Searches</dt>
					<dd>{r.searchCount}</dd>
				</div>
				<div>
					<dt>Conversion</dt>
					<dd>{billing ? CONVERSION_LABELS[r.conversion] : "–"}</dd>
				</div>
				{r.unpricedCalls > 0 && (
					<div>
						<dt>Unpriced calls</dt>
						<dd>{r.unpricedCalls}</dd>
					</div>
				)}
			</dl>
			{r.recentTopics.length > 0 && <p className="dash-note">Topics: {r.recentTopics.join(" · ")}</p>}
			<div className="dash-actions">
				<PauseButton tenantId={r.tenantId} paused={r.paused} back={back} name={displayName(r)} />
				<Link className="dash-btn" href={`/admin/students/${r.tenantId}`}>
					Details
				</Link>
			</div>
		</div>
	);
}
