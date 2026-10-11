@AGENTS.md

## Project notes

- Steam calls live in `lib/steam/api.ts`. For bulk game data prefer `IStoreBrowseService/GetItems`
  (api.steampowered.com, no key, 100 ids per call): `getStoreMetaBatch` (taste-analysis metadata),
  `getStoreItemPricesBatch` (wishlist prices), `getReviewSummariesBatch`, `getStoreItemsBatch` (deal track).
  Per-game `appdetails` (store host, ~200 req / 5 min per IP, shared 429 backoff) is only for the game
  detail page and single-game lookups.
- GetItems quirks: `is_free` is also true for 100%-off giveaways (use `storeItemIsFreeToPlay`);
  `best_purchase_option` may be a bundle (use `storeItemPriceIsAppPrice` before treating it as the game's price).
  Write prices from GetItems only through `recordStoreItemPrice` (it never overwrites last-known with null).
- `lib/cache.ts` routes per-game keys (`storemeta:`, `reviewsummary:`, `storeitem:`, `app:{id}:price:`) to a
  separate 60k LRU; everything else uses the 10k general LRU. New bulk per-game keys should match that prefix list.
  `cacheGet` deletes a stale entry when it reads it, so keep the value if you need it as a fallback.
- `/recommend`: value-for-money, sale-only and result count are re-ranked client-side from the pool
  (`lib/recommend-rerank.ts`) and are excluded from the result cache key. Server and client share the pool rules there.
- Many source files use CRLF line endings; keep them when editing.
- Verify with `npx tsc --noEmit`, `npx eslint lib app __tests__`, `npx vitest run`.
