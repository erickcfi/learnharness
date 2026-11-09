/**
 * The front door's background jobs (P1-08, P1-09): the day-91 delete and
 * the nightly tenant copies. One timer: the first tick a minute after the
 * front door starts, then one every hour. Each job decides on each tick
 * whether it has work (both are safe to repeat), so a restart or a deploy
 * never skips a day. A job never runs twice at once, and a failure is
 * logged and tried again on the next tick.
 *
 * In-process on purpose: the jobs need the volume, and a Railway volume
 * mounts on one service only.
 */

export interface Job {
	name: string;
	run(): Promise<unknown>;
}

export interface JobScheduler {
	/** Runs every job once now, waiting for jobs already running. */
	runNow(): Promise<void>;
	/** Stops the timer and waits for running jobs. */
	stop(): Promise<void>;
}

export const FIRST_TICK_MS = 60_000;
export const TICK_MS = 60 * 60 * 1000;

function errorCode(error: unknown): string {
	const code = (error as { code?: unknown } | null)?.code;
	return typeof code === "string" ? code : ((error as Error | null)?.name ?? "Error");
}

export function startJobs(jobs: readonly Job[], options: { firstTickMs?: number; tickMs?: number; log?: (line: string) => void } = {}): JobScheduler {
	const log = options.log ?? ((line: string) => console.error(line));
	const running = new Map<string, Promise<void>>();
	let stopped = false;

	function runJob(job: Job): Promise<void> {
		const current = running.get(job.name);
		if (current) return current;
		const work = job
			.run()
			.then(
				() => undefined,
				(error: unknown) => log(`jobs: ${job.name} failed (${errorCode(error)}); it runs again on the next tick`),
			)
			.finally(() => running.delete(job.name));
		running.set(job.name, work);
		return work;
	}

	const tick = () => {
		if (!stopped) for (const job of jobs) void runJob(job);
	};
	const first = setTimeout(() => {
		tick();
		interval = setInterval(tick, options.tickMs ?? TICK_MS);
		interval.unref();
	}, options.firstTickMs ?? FIRST_TICK_MS);
	first.unref();
	let interval: NodeJS.Timeout | undefined;

	return {
		async runNow() {
			await Promise.all(jobs.map(runJob));
		},
		async stop() {
			stopped = true;
			clearTimeout(first);
			if (interval) clearInterval(interval);
			await Promise.all([...running.values()]);
		},
	};
}
