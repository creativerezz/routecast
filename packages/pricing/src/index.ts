import rawSnapshot from "../data/models.json";
import { createResolver } from "./resolve.js";
import { type PricingSnapshot, pricingSnapshotSchema } from "./schema.js";

export type { CostBreakdown, CostInput } from "./cost.js";
export { blendedPerMtok, computeCost } from "./cost.js";
export type { ModelResolver } from "./resolve.js";
export { createResolver, normalizeModelId } from "./resolve.js";
export type {
  CacheConfig,
  ModelEntry,
  PriceTier,
  PricingSnapshot,
  Provider,
  WorkloadType,
} from "./schema.js";
export {
  cacheSchema,
  modelEntrySchema,
  priceTierSchema,
  pricingSnapshotSchema,
  providerSchema,
  workloadTypeSchema,
  workloadTypes,
} from "./schema.js";

/** The bundled pricing snapshot, validated at module load. */
export const defaultSnapshot: PricingSnapshot = pricingSnapshotSchema.parse(rawSnapshot);

/** Resolver over the bundled snapshot. */
export const defaultResolver = createResolver(defaultSnapshot);

/** Days since the snapshot's asOf date. */
export function snapshotAgeDays(snapshot: PricingSnapshot, now: Date): number {
  const asOf = new Date(`${snapshot.asOf}T00:00:00Z`);
  return Math.floor((now.getTime() - asOf.getTime()) / 86_400_000);
}

/** Pricing older than this many days triggers a staleness warning (market moves at multi-week cadence). */
export const STALENESS_THRESHOLD_DAYS = 45;
