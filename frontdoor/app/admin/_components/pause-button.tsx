"use client";

import type { FormEvent } from "react";

/**
 * Pause or unpause one student (C3 req 6). A plain form, so it works without
 * JavaScript; with JavaScript, a pause asks first, since a stray tap on a
 * phone would stop a student's tutor.
 */
export function PauseButton({ tenantId, paused, back, name }: { tenantId: string; paused: boolean; back: string; name: string }) {
	function onSubmit(event: FormEvent<HTMLFormElement>) {
		if (!paused && !window.confirm(`Pause ${name}? Their tutor stops taking new turns until you unpause them.`)) event.preventDefault();
	}
	return (
		<form method="post" action={`/admin/api/tenants/${tenantId}/${paused ? "unpause" : "pause"}`} onSubmit={onSubmit}>
			<input type="hidden" name="back" value={back} />
			<button type="submit" className={paused ? "primary" : "danger-outline"}>
				{paused ? "Unpause" : "Pause"}
			</button>
		</form>
	);
}
