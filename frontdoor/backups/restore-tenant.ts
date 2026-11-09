/**
 * Restore one tenant folder from a backup copy (P1-09, X3). Plain Node
 * runs it (type stripping), for example in the Railway service's shell:
 *
 *   node frontdoor/backups/restore-tenant.ts --tenant <id> --from <backup dir> --scratch <empty dir>
 *   node frontdoor/backups/restore-tenant.ts --tenant <id> --from <backup dir> --live [--volume /data]
 *
 * --scratch copies into <empty dir>/<id> and checks it; nothing live changes.
 * --live puts the copy in <volume>/tenants/<id>, moves the folder that was
 * there to <volume>/restore-kept/, and stops that tenant's tutor server so
 * it starts again on the restored folder. Runbook:
 * docs/decisions/2026-11-08-backups.md.
 *
 * Prints counts and paths only. Exit code 0 on success, 1 on failure, 2 on
 * wrong arguments.
 */
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { tenantDir } from "../tenants/paths.ts";
import { findTenantServerPids, restoreTenantFolder, type RestoreTarget } from "./restore.ts";

const USAGE = `Usage:
  node frontdoor/backups/restore-tenant.ts --tenant <id> --from <backup dir> --scratch <empty dir>
  node frontdoor/backups/restore-tenant.ts --tenant <id> --from <backup dir> --live [--volume /data]`;

export async function main(argv: string[], env: Record<string, string | undefined> = process.env, out: (line: string) => void = console.log): Promise<number> {
	let values: { tenant?: string; from?: string; scratch?: string; live?: boolean; volume?: string; help?: boolean };
	try {
		values = parseArgs({
			args: argv,
			options: { tenant: { type: "string" }, from: { type: "string" }, scratch: { type: "string" }, live: { type: "boolean" }, volume: { type: "string" }, help: { type: "boolean" } },
			strict: true,
		}).values;
	} catch (error) {
		out(`${(error as Error).message}\n${USAGE}`);
		return 2;
	}
	if (values.help || !values.tenant || !values.from || Boolean(values.scratch) === Boolean(values.live)) {
		out(USAGE);
		return values.help ? 0 : 2;
	}
	const volumeDir = values.volume ?? env.FRONTDOOR_VOLUME ?? "/data";
	const target: RestoreTarget = values.scratch ? { kind: "scratch", dir: values.scratch } : { kind: "live", volumeDir };
	try {
		const result = await restoreTenantFolder({
			backupDir: values.from,
			tenantId: values.tenant,
			target,
			stopTenant: async (tenantId) => {
				const pids = findTenantServerPids(tenantDir(volumeDir, tenantId));
				for (const pid of pids) {
					try {
						process.kill(pid, "SIGTERM");
					} catch {
						// Already gone.
					}
				}
				out(`Stopped ${pids.length} running tutor server(s) for this tenant. The next request starts it on the restored folder.`);
			},
		});
		out(`Restored ${result.files} files (${result.bytes} bytes) to ${result.restoredTo}`);
		out(`Checked: every file matches the backup${result.manifestChecked ? ", and the backup matches its manifest" : " (no manifest in this backup)"}.`);
		if (result.keptAside) out(`The folder it replaced is kept at ${result.keptAside}. Remove it when you are sure.`);
		return 0;
	} catch (error) {
		out(`Restore failed: ${(error as Error).message}`);
		return 1;
	}
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	process.exitCode = await main(process.argv.slice(2));
}
