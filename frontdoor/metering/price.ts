/**
 * Prices for the metering proxy (C3 requirements 4 and 7).
 *
 * Model calls are priced by upstream's own code (src/server/pricing.ts,
 * Pi's catalog), so the proxy's dollars match upstream's records.
 */

import { callCost } from "../../src/server/pricing.ts";
import type { TokenUsage } from "./store.ts";

/** Dollars at list price for one Anthropic call, or null when the price list has no rate for the model. */
export function listPrice(model: string, usage: TokenUsage): number | null {
	return callCost(usage, `anthropic:${model}`);
}

/** Tavily basic search, list price per search: 0.8 cents (N11, K5). */
const SEARCH_FEE_TENTHS_OF_A_CENT = 8;
export const SEARCH_FEE_DOLLARS = SEARCH_FEE_TENTHS_OF_A_CENT / 1000;

/** The search fee: searches x $0.008, worked in tenths of a cent so the result has no rounding drift. */
export function searchFeeDollars(searches: number): number {
	return (searches * SEARCH_FEE_TENTHS_OF_A_CENT) / 1000;
}
