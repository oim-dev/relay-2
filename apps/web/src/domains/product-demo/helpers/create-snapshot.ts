import { PRODUCT_DEMO_SEED } from "../config/seed";
import type { ProductSnapshot } from "../types/product-demo.type";

/**
 * Создаёт независимый заполненный или пустой набор.
 */
export const createSnapshot = (isEmpty = false): ProductSnapshot => {
  const snapshot = structuredClone(PRODUCT_DEMO_SEED);
  snapshot.epoch = crypto.randomUUID();
  if (!isEmpty) return snapshot;
  return {
    ...snapshot,
    passport: { id: "passport", name: "", summary: "", description: "" },
    features: [],
    applications: [],
    contributions: [],
    work: [],
    documentation: [],
  };
};
