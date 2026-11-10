/**
 * Upload many files to the library, one after another. Kept apart from the
 * form so it can be tested without a browser: the caller passes `send`, which
 * does one PUT. One failure never stops the rest.
 */

export type SendResult = { status: number; body: { error?: string; code?: string; replaced?: boolean } };
export type FileOutcome = { name: string; result: "added" | "replaced" | "skipped" | "error"; message: string };

export type BatchFile = { name: string; size: number };

export async function uploadBatch<F extends BatchFile>(
	files: readonly F[],
	opts: {
		maxMb: number;
		replace: boolean;
		send: (file: F, replace: boolean) => Promise<SendResult>;
		/** Called before each file starts (index is 0-based) and once more with the finished count. */
		onProgress?: (done: number, total: number, current: F | null) => void;
		onResult?: (outcome: FileOutcome) => void;
	},
): Promise<FileOutcome[]> {
	const out: FileOutcome[] = [];
	const push = (o: FileOutcome) => {
		out.push(o);
		opts.onResult?.(o);
	};
	for (const [i, file] of files.entries()) {
		opts.onProgress?.(i, files.length, file);
		if (file.size > opts.maxMb * 1024 * 1024) {
			push({ name: file.name, result: "error", message: `Files can be up to ${opts.maxMb} MB.` });
			continue;
		}
		try {
			const res = await opts.send(file, opts.replace);
			if (res.status === 200) {
				const replaced = res.body.replaced === true;
				push({ name: file.name, result: replaced ? "replaced" : "added", message: replaced ? "Replaced." : "Added." });
			} else if (res.status === 409 && res.body.code === "exists") {
				push({ name: file.name, result: "skipped", message: "Skipped. It is already in the library." });
			} else {
				push({ name: file.name, result: "error", message: res.body.error ?? `The upload failed (${res.status}).` });
			}
		} catch (error) {
			push({ name: file.name, result: "error", message: (error as Error).message });
		}
	}
	opts.onProgress?.(files.length, files.length, null);
	return out;
}

export function summarize(outcomes: readonly FileOutcome[]): string {
	const n = (r: FileOutcome["result"]) => outcomes.filter((o) => o.result === r).length;
	const parts = [`${n("added")} added`, `${n("replaced")} replaced`, `${n("skipped")} skipped`, `${n("error")} failed`];
	return `Done. ${parts.join(", ")}.`;
}
