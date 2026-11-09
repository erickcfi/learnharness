/**
 * Loaded before a server starts, with Node's --import option:
 *   node --import <repo>/frontdoor/log-hygiene/preload.ts .next/standalone/server.js
 * Installs the console filter in filter.ts (PRD cross-cutting requirement 3).
 */
import { installLogFilter } from "./filter.ts";

installLogFilter();
