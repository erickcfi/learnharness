"use client";

import { type FormEvent, useState } from "react";

const ACCEPT = ".pdf,.md,.txt,.csv,.png,.jpg,.jpeg,.gif,.webp";

/**
 * Upload one file to the library. The file goes as the request body (PUT
 * /admin/api/library), so even a large PDF never sits in memory on the
 * server. A file of the same name is replaced only after the Owner says yes.
 */
export function UploadForm({ areas, maxMb }: { areas: Array<{ value: string; label: string }>; maxMb: number }) {
	const [area, setArea] = useState(areas[0]?.value ?? "faa");
	const [status, setStatus] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);

	function send(file: File, aircraft: string, replace: boolean): Promise<{ status: number; body: { error?: string; code?: string } }> {
		return new Promise((resolve, reject) => {
			const q = new URLSearchParams({ area, name: file.name });
			if (area === "poh") q.set("aircraft", aircraft);
			if (replace) q.set("replace", "1");
			const xhr = new XMLHttpRequest();
			xhr.open("PUT", `/admin/api/library?${q.toString()}`);
			xhr.setRequestHeader("Content-Type", "application/octet-stream");
			xhr.setRequestHeader("Accept", "application/json");
			xhr.upload.onprogress = (e) => {
				if (e.lengthComputable) setStatus(`Uploading… ${Math.round((e.loaded / e.total) * 100)}%`);
			};
			xhr.onload = () => {
				let body: { error?: string; code?: string } = {};
				try {
					body = JSON.parse(xhr.responseText) as typeof body;
				} catch {
					// keep empty
				}
				resolve({ status: xhr.status, body });
			};
			xhr.onerror = () => reject(new Error("The upload stopped. Check the connection and try again."));
			xhr.send(file);
		});
	}

	async function onSubmit(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		const form = event.currentTarget;
		const file = (form.elements.namedItem("file") as HTMLInputElement).files?.[0];
		const aircraft = (form.elements.namedItem("aircraft") as HTMLInputElement | null)?.value ?? "";
		if (!file) return setStatus("Choose a file first.");
		if (file.size > maxMb * 1024 * 1024) return setStatus(`Files can be up to ${maxMb} MB.`);
		setBusy(true);
		try {
			let res = await send(file, aircraft, false);
			if (res.status === 409) {
				if (!window.confirm(`${file.name} is already in the library. Replace it?`)) {
					setStatus("Not uploaded. The library file is unchanged.");
					return;
				}
				res = await send(file, aircraft, true);
			}
			if (res.status === 200) {
				window.location.assign("/admin/library?done=uploaded");
				return;
			}
			setStatus(res.body.error ?? `The upload failed (${res.status}).`);
		} catch (error) {
			setStatus((error as Error).message);
		} finally {
			setBusy(false);
		}
	}

	return (
		<form onSubmit={onSubmit}>
			<label htmlFor="area">Folder</label>
			<select id="area" name="area" value={area} onChange={(e) => setArea(e.target.value)}>
				{areas.map((a) => (
					<option key={a.value} value={a.value}>
						{a.label}
					</option>
				))}
			</select>
			{area === "poh" && (
				<>
					<label htmlFor="aircraft">Aircraft folder</label>
					<input id="aircraft" name="aircraft" type="text" placeholder="c172s" autoCapitalize="none" required />
				</>
			)}
			<label htmlFor="file">File (PDF, text or image, up to {maxMb} MB)</label>
			<input id="file" name="file" type="file" accept={ACCEPT} required />
			<div className="ad-actions">
				<button type="submit" className="primary" disabled={busy}>
					{busy ? "Uploading…" : "Upload"}
				</button>
			</div>
			{status && (
				<p className="ad-note" role="status">
					{status}
				</p>
			)}
		</form>
	);
}
