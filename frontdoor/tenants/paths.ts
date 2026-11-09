/**
 * Where a tenant's files live on the volume (PRD C1 req 2).
 *
 *   <volume>/tenants/<tenantId>/   the tenant's LearnHarness data (LH_DATA_DIR)
 *   <volume>/auth/<tenantId>.json  the tenant server's key file (LH_AUTH_FILE),
 *                                  kept OUTSIDE the data folder
 *
 * A tenant ID is always a UUID. Checking that before any path is built means
 * no ID can climb out of tenants/ ("..", "/", empty).
 */
import * as path from "node:path";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function isTenantId(value: string): boolean {
	return UUID.test(value);
}

export function assertTenantId(value: string): void {
	if (!isTenantId(value)) throw new Error(`Invalid tenant id: ${JSON.stringify(value).slice(0, 60)}`);
}

export function tenantDir(volumeDir: string, tenantId: string): string {
	assertTenantId(tenantId);
	return path.join(path.resolve(volumeDir), "tenants", tenantId);
}

export function tenantAuthFile(volumeDir: string, tenantId: string): string {
	assertTenantId(tenantId);
	return path.join(path.resolve(volumeDir), "auth", `${tenantId}.json`);
}
