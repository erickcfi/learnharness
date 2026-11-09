import { DONE_MESSAGES } from "../_lib/format.ts";

/** The line a form leaves after its 303 back to the page (?done= or ?error=). */
export function Flash({ done, error }: { done?: string; error?: string }) {
	if (error) return <p className="ad-flash err" role="alert">{error.slice(0, 300)}</p>;
	const message = done ? DONE_MESSAGES[done] : undefined;
	if (!message) return null;
	return <p className="ad-flash" role="status">{message}</p>;
}
