# Upstream changes

Every upstream file that the fork changes gets one row here. Merges from upstream start by checking each file in this list.

| File | Card | Reason |
|---|---|---|
| `src/agent/models.ts` | P2-01 | Metering (X2). With `LH_ANTHROPIC_BASE_URL` set, the Anthropic provider sends every request to that address, the metering proxy. Unset, requests are untouched. Adds `viaMeteringProxy` and one call to it in `piModels()`. |
| `src/server/search.ts` | P2-02 | Search counter (X2, C3 requirement 7). With `LH_TAVILY_BASE_URL` set, Tavily searches go to that address, the metering proxy, which counts them per tenant. Unset, upstream's endpoint. Adds `tavilySearchUrl()`, used by `tavilyProvider`. |
