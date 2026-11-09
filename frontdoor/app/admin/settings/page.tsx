import { Flash } from "../_components/flash.tsx";
import { dayTime } from "../_lib/format.ts";
import { param, requireAdmin } from "../_lib/guard.ts";

/** The alert and autopause thresholds (C3 req 5, C7 req 5). */
export default async function SettingsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
	const { rt } = await requireAdmin();
	const q = await searchParams;
	const s = await rt.thresholds();
	return (
		<>
			<Flash done={param(q.done)} error={param(q.error)} />
			<h1>Settings</h1>
			<h2>Cost thresholds</h2>
			<form method="post" action="/admin/api/thresholds" className="ad-card">
				<input type="hidden" name="back" value="/admin/settings" />
				<label htmlFor="alertUsd">Alert at this model cost in 30 days ($)</label>
				<input id="alertUsd" name="alertUsd" type="text" inputMode="decimal" defaultValue={s.alertUsd.toFixed(2)} required />
				<label htmlFor="autopauseUsd">Pause the student at this model cost in 30 days ($)</label>
				<input id="autopauseUsd" name="autopauseUsd" type="text" inputMode="decimal" defaultValue={s.autopauseUsd.toFixed(2)} required />
				<p className="ad-note">
					Each student's model cost over the last 30 days is checked against these. An alert shows on the Students page. Autopause stops the tutor for
					that student until you unpause them. The alert must be lower than autopause.
				</p>
				<div className="ad-actions">
					<button type="submit" className="primary">
						Save
					</button>
				</div>
				<p className="ad-note">Last changed {dayTime(s.updatedAt, rt.timeZone)}.</p>
			</form>
		</>
	);
}
