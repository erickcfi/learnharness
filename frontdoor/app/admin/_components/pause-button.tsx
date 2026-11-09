/** Pause or unpause one student (C3 req 6). A plain form: works without JavaScript. */
export function PauseButton({ tenantId, paused, back }: { tenantId: string; paused: boolean; back: string }) {
	return (
		<form method="post" action={`/admin/api/tenants/${tenantId}/${paused ? "unpause" : "pause"}`}>
			<input type="hidden" name="back" value={back} />
			<button type="submit" className={paused ? "primary" : "danger"}>
				{paused ? "Unpause" : "Pause"}
			</button>
		</form>
	);
}
