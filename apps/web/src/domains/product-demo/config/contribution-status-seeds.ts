import type { ProductStatus } from "../types/product-demo.type";

/** Самостоятельная готовность вкладов приложений; остальные начинаются с «Не готово». */
export const CONTRIBUTION_FEATURE_STATUS_SEEDS: Record<string, ProductStatus> = {
  "web/catalog": "partial",
  "api/catalog": "partial",
  "web/booking": "done",
  "api/booking": "done",
  "admin/booking": "done",
  "web/profiles": "done",
  "api/profiles": "done",
  "web/moderation": "done",
  "api/moderation": "done",
  "admin/moderation": "done",
  "api/ai-chat": "done",
  "api/notifications": "partial",
  "web/reviews": "partial",
  "api/reviews": "partial",
};

/** Неоднородные сценарии в частично выполненных вкладах. Это исходные моки, не правило агрегации. */
export const CONTRIBUTION_SCENARIO_STATUS_SEEDS: Record<string, ProductStatus> = {
  "web/catalog-search": "done",
  "web/catalog-card": "done",
  "api/catalog-search": "done",
  "api/catalog-filters": "done",
  "api/catalog-card": "done",
  "api/catalog-sort": "none",
  "api/notifications-booking": "done",
  "api/notifications-return": "none",
  "web/reviews-write": "done",
  "web/reviews-report": "none",
  "api/reviews-write": "done",
  "api/reviews-report": "none",
};
