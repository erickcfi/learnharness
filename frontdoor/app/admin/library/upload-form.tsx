"use client";

import { useRouter } from "next/navigation";
import { type FormEvent, useState } from "react";
import { type FileOutcome, type SendResult, summarize, uploadBatch } from "./upload-batch.ts";

const ACCEPT = ".pdf,.md,.txt,.csv,.png,.jpg,.jpeg,.gif,.webp";

/**
 * Upload files to the library, one after another. Each file goes as the
 * request body (PUT /admin/api/library), so even a large PDF never sits in
 * memory on the server. A file of the same name is replaced only when the
 * Owner ticks the box; otherwise it is skipped.
 */
export function UploadForm({ areas, maxMb }: { areas: Array<{ value: string; label: string }>; maxMb: number }) {
	const router = useRouter();
	const [area, setArea] = useState(areas[0]?.value ?? "faa");
	const [replace, setReplace] = useState(false);
	const [status, setStatus] = useState<string | null>(null);
	const [outcomes, setOutcomes] = useState<FileOutcome[]>([]);
	const [busy, setBusy] = useState(false);

	function send(file: File, aircraft: string, doReplace: boolean, label: string): Promise<SendResult> {
		return new Promise((resolve, reject) => {
			const q = new URLSearchParams({ area, name: file.name });
			if (area === "poh") q.set("aircraft", aircraft);
			if (doReplace) q.set("replace", "1");
			const xhr = new XMLHttpRequest();
			xhr.open("PUT", `/admin/api/library?${q.toString()}`);
			xhr.setRequestHeader("Content-Type", "application/octet-stream");
			xhr.setRequestHeader("Accept", "application/json");
			xhr.upload.onprogress = (e) => {
				if (e.lengthComputable) setStatus(`${label}: ${file.name} ${Math.round((e.loaded / e.total) * 100)}%`);
			};
			xhr.onload = () => {
				let body: SendResult["body"] = {};
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
		const files = Array.from((form.elements.namedItem("file") as HTMLInputElement).files ?? []);
		const aircraft = (form.elements.namedItem("aircraft") as HTMLInputElement | null)?.value ?? "";
		if (files.length === 0) return setStatus("Choose at least one file first.");
		setBusy(true);
		setOutcomes([]);
		let label = "";
		try {
			const results = await uploadBatch(files, {
				maxMb,
				replace,
				send: (file, doReplace) => send(file, aircraft, doReplace, label),
				onProgress: (done, total) => {
					label = `${Math.min(done + 1, total)} of ${total}`;
					setStatus(done < total ? `Uploading ${label}` : null);
				},
				onResult: (o) => setOutcomes((prev) => [...prev, o]),
			});
			setStatus(summarize(results));
			router.refresh();
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
			<label htmlFor="file">Files (PDF, text or image, up to {maxMb} MB each)</label>
			<input id="file" name="file" type="file" accept={ACCEPT} multiple required />
			<label htmlFor="replace" className="ad-row">
				<input id="replace" type="checkbox" checked={replace} onChange={(e) => setReplace(e.target.checked)} /> Replace files that already exist
			</label>
			<div className="ad-actions">
				<button type="submit" className="primary" disabled={busy}>
					{busy ? "Uploading…" : "Upload files"}
				</button>
			</div>
			{status && (
				<p className="ad-note" role="status">
					{status}
				</p>
			)}
			{outcomes.length > 0 && (
				<ul className="ad-list" aria-label="Upload results">
					{outcomes.map((o, i) => (
						<li key={`${i}-${o.name}`} className="ad-row">
							<strong>{o.name}</strong>: {o.message}
						</li>
					))}
				</ul>
			)}
		</form>
	);
}
