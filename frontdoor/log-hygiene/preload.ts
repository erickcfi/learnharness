/**
 * Loaded before a server starts, with Node's --import option:
 *   node --import <repo>/frontdoor/log-hygiene/preload.ts .next/standalone/server.js
 * Installs the console filter in filter.ts, the crash listeners in
 * crash.ts, and the warning printer in warnings.ts (PRD cross-cutting
 * requirement 3).
 *
 * In a tenant server, LH_LOG_MARK is the front door's line mark
 * (wiring/tenant-logs.ts). It is read once and removed from the
 * environment, so the tenant's own child processes do not get it.
 */
import { installCrashHandlers } from "./crash.ts";
import { installLogFilter, LOG_MARK_ENV } from "./filter.ts";
import { installWarningPrinter } from "./warnings.ts";

const mark = process.env[LOG_MARK_ENV] || undefined;
delete process.env[LOG_MARK_ENV];

installLogFilter(console, { mark });
installCrashHandlers({ mark });
installWarningPrinter(console);
