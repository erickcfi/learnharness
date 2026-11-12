import Link from "next/link";
import { AREA_LABELS, LIBRARY_AREAS, LIBRARY_MAX_BYTES } from "../../../library/rules.ts";
import { Flash } from "../_components/flash.tsx";
import { bytes, day } from "../_lib/format.ts";
import { param, requireAdmin } from "../_lib/guard.ts";
import { UploadForm } from "./upload-form.tsx";

/**
 * The source library (P5-01, C4, PD6): what is there, an upload form, and
 * remove with a confirm step. Every student's tutor reads these files; no
 * student can change them.
 */
export default async function LibraryPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
	const { rt } = await requireAdmin();
	const q = await searchParams;
	const files = await rt.library();
	const confirm = param(q.remove);
	const toRemove = confirm ? files.find((f) => f.relPath === confirm) : undefined;

	return (
		<>
			<Flash done={param(q.done)} error={param(q.error)} />
			<h1>Library</h1>
			<p className="dash-muted">Every student's tutor reads these files. Students cannot change them.</p>

			{toRemove && (
				<div className="dash-card alert" role="alertdialog" aria-labelledby="confirm-title">
					<p id="confirm-title">
						<strong>Remove {toRemove.name}?</strong> Tutors stop seeing it at once. This cannot be undone.
					</p>
					<form method="post" action="/admin/api/library/remove" className="dash-actions">
						<input type="hidden" name="path" value={toRemove.relPath} />
						<input type="hidden" name="confirm" value="yes" />
						<input type="hidden" name="back" value="/admin/library" />
						<button type="submit" className="danger">
							Yes, remove it
						</button>
						<Link className="dash-btn" href="/admin/library">
							Cancel
						</Link>
					</form>
				</div>
			)}

			<h2>Add a file</h2>
			<div className="dash-card">
				<UploadForm areas={LIBRARY_AREAS.map((a) => ({ value: a, label: AREA_LABELS[a] }))} maxMb={LIBRARY_MAX_BYTES / (1024 * 1024)} />
			</div>

			{LIBRARY_AREAS.map((area) => {
				const inArea = files.filter((f) => f.area === area);
				return (
					<section key={area}>
						<h2>
							{AREA_LABELS[area]} ({inArea.length})
						</h2>
						{area === "course" && (
							<p className="dash-muted">
								The course file for the /course page. Students see the course only while a valid file is here. Make it with frontdoor/course/build-course-file.ts.
							</p>
						)}
						{inArea.length === 0 ? (
							<p className="dash-muted">No files yet.</p>
						) : (
							<ul className="dash-list">
								{inArea.map((f) => (
									<li key={f.relPath} className="dash-row" style={{ justifyContent: "space-between" }}>
										<span>
											{f.folder && <span className="dash-badge">{f.folder}</span>} {f.name}
											<br />
											<span className="dash-muted">
												{bytes(f.bytes)} · {day(f.modifiedAt, rt.timeZone)}
											</span>
										</span>
										<Link className="dash-btn" href={`/admin/library?remove=${encodeURIComponent(f.relPath)}`}>
											Remove
										</Link>
									</li>
								))}
							</ul>
						)}
					</section>
				);
			})}
		</>
	);
}
