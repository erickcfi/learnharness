import Link from "next/link";
import { requireAdmin } from "../../../../_lib/guard.ts";

/**
 * One session's text (C7 req 3, D19). Shown only while the student's
 * opt-in or a tester's written OK is active: the runtime checks consent on
 * this very request before it asks the tenant's server, and nothing is
 * kept afterwards. Shown as plain text, never as HTML.
 */
export default async function SessionTextPage({ params }: { params: Promise<{ tenantId: string; chatId: string }> }) {
	const { rt } = await requireAdmin();
	const { tenantId, chatId } = await params;
	const view = await rt.sessionText(tenantId, decodeURIComponent(chatId));
	return (
		<>
			<p className="ad-muted">
				<Link href={`/admin/students/${tenantId}`}>← Back to the student</Link>
			</p>
			<h1>Session text</h1>
			{view.allowed ? (
				view.text === null ? (
					<p className="ad-flash err">The student's tutor did not give this session. Try again in a minute.</p>
				) : (
					<pre className="ad-text">{view.text}</pre>
				)
			) : (
				<p className="ad-flash err">This student has not shared session text. You see only titles, topics and numbers.</p>
			)}
		</>
	);
}
