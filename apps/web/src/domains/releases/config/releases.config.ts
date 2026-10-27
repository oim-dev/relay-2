import type { ReleaseStatus } from "../types/release.type";
import { RELEASE_STATUSES } from "@relay/contracts";
export const RELEASE_STATUS_LABELS: Record<ReleaseStatus, string> = {
  planned: "Запланирован",
  released: "Выпущен",
  cancelled: "Отменён",
};
export const RELEASE_STATUS_COLORS: Record<ReleaseStatus, string> = {
  planned: "blue",
  released: "teal",
  cancelled: "gray",
};
export const RELEASE_STATUS_OPTIONS = [
  { value: "planned", label: "Запланирован" },
  { value: "released", label: "Выпущен" },
  { value: "cancelled", label: "Отменён" },
];

/**
 * Разбирает собственное состояние выпуска из URL.
 */
export const releaseStatusFromValue = (value: string | null): ReleaseStatus | undefined =>
  RELEASE_STATUSES.find((status) => status === value);
