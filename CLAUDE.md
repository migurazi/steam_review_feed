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
- `/bundle`: IsThereAnyDeal bundle data via `lib/itad/` client (`/bundles/v1` for list, `lookup/shop/61/id` for
  UUID→appid mapping; Steam shop ID is 61, key is optional query param). Bundle game enrichment via `getBundleGameRows`
  (prices reuse `getStoreItemPricesBatch`). Steam package/bundle expansion via `expandSteamCollection`. ITAD response
  caching uses general LRU (not per-game split). Exchange rates via `lib/fx.ts` (`/api/fx`, open.er-api.com base USD,
  12h cache, KRW conversion). Output formatters in `lib/bundle/format.ts`: HTML links open in new tabs (`target=_blank`),
  `<table border="1">` for standalone HTML, markdown/SG/BBCode escape game titles (injection prevention). Preview uses
  class-based dark mode (`.dark` class, no prefers-color-scheme).
- Many source files use CRLF line endings; keep them when editing.
- Verify with `npx tsc --noEmit`, `npx eslint lib app __tests__`, `npx vitest run`.
