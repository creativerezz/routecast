import { z } from "zod";

export const providerSchema = z.enum([
  "anthropic",
  "openai",
  "google",
  "xai",
  "deepseek",
  "amazon",
  "mistral",
  "alibaba",
  "moonshot",
  "meta",
  "cohere",
  "other",
]);
export type Provider = z.infer<typeof providerSchema>;

export const workloadTypes = [
  "chat",
  "rag-short",
  "rag-long",
  "coding",
  "agentic-loop",
  "extraction",
  "summarization",
] as const;
export const workloadTypeSchema = z.enum(workloadTypes);
export type WorkloadType = z.infer<typeof workloadTypeSchema>;

/**
 * A pricing tier. Threshold semantics: the tier whose range contains the TOTAL
 * prompt size (input + cache read + cache write) prices ALL input tokens in the
 * request. This matches how Gemini long-context pricing and the GPT-5.5 272K
 * cliff actually bill (the whole request is repriced, not the marginal tokens).
 */
export const priceTierSchema = z.object({
  /** Upper bound (inclusive) of prompt tokens for this tier; null = unbounded last tier. */
  upToContextTokens: z.number().int().positive().nullable(),
  inputPerMtok: z.number().nonnegative(),
  outputPerMtok: z.number().nonnegative(),
});
export type PriceTier = z.infer<typeof priceTierSchema>;

export const cacheSchema = z.object({
  /** Cache-hit read price as a multiplier on the tier input price (0.1 = 90% off). */
  readMultiplier: z.number().gt(0).lt(1),
  /** Cache write price as a multiplier on the tier input price (1.25 = Anthropic 5-min TTL). Default 1 = writes billed as normal input. */
  writeMultiplier: z.number().gt(0).max(2).optional(),
  /** Provider minimum cacheable prefix size. */
  minCacheableTokens: z.number().int().positive(),
});
export type CacheConfig = z.infer<typeof cacheSchema>;

export const deprecationSchema = z.object({
  /** ISO date the model is retired by the provider. */
  retiresOn: z.string().optional(),
  /** Canonical key of the recommended replacement model. */
  replacement: z.string().optional(),
});

export const modelEntrySchema = z.object({
  /** Canonical key, "<provider>/<model-slug>". */
  key: z.string().regex(/^[a-z0-9-]+\/[a-z0-9.-]+$/),
  provider: providerSchema,
  displayName: z.string(),
  /**
   * Glob patterns matched against normalized raw model ids from logs
   * ("claude-sonnet-4-6-20250929", "us.anthropic.claude-haiku-4-5-...").
   * Only "*" is special (matches any run of characters).
   */
  aliases: z.array(z.string()).min(1),
  contextWindow: z.number().int().positive(),
  tiers: z.array(priceTierSchema).min(1),
  cache: cacheSchema.nullable(),
  /** Batch API price multiplier (0.5 = 50% off). Omit when no batch API. */
  batchDiscount: z.number().gt(0).lt(1).optional(),
  /** How reasoning/thinking tokens are billed. "output" = billed at output rate (the norm in 2026). */
  reasoningBilledAs: z.enum(["output", "separate", "none"]),
  /** Artificial Analysis Intelligence Index (v3) or best-effort estimate — see pricingConfidence/notes. */
  intelligenceIndex: z.number().optional(),
  /** Fitness per workload, 0 (unsuitable) – 3 (excellent). Absent = unknown (treated as 2 for the model's own traffic, never recommended into). */
  workloadFitness: z.record(workloadTypeSchema, z.number().int().min(0).max(3)).optional(),
  deprecation: deprecationSchema.optional(),
  /** "confirmed" = sourced from provider docs; "estimated" = best-effort, flagged in findings. */
  pricingConfidence: z.enum(["confirmed", "estimated"]).default("confirmed"),
  notes: z.string().optional(),
});
export type ModelEntry = z.infer<typeof modelEntrySchema>;

export const pricingSnapshotSchema = z
  .object({
    /** ISO date the prices were verified. Staleness warnings key off this. */
    asOf: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    version: z.string(),
    models: z.array(modelEntrySchema).min(1),
  })
  .superRefine((snapshot, ctx) => {
    const seen = new Set<string>();
    for (const [i, m] of snapshot.models.entries()) {
      if (seen.has(m.key)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["models", i, "key"],
          message: `duplicate model key "${m.key}"`,
        });
      }
      seen.add(m.key);

      const last = m.tiers[m.tiers.length - 1];
      if (last && last.upToContextTokens !== null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["models", i, "tiers"],
          message: `last tier of "${m.key}" must be unbounded (upToContextTokens: null)`,
        });
      }
      for (let t = 1; t < m.tiers.length; t++) {
        const prev = m.tiers[t - 1];
        const cur = m.tiers[t];
        if (!prev || !cur) continue;
        if (prev.upToContextTokens === null) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["models", i, "tiers", t - 1],
            message: `only the last tier of "${m.key}" may be unbounded`,
          });
        } else if (
          cur.upToContextTokens !== null &&
          cur.upToContextTokens <= prev.upToContextTokens
        ) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["models", i, "tiers", t],
            message: `tiers of "${m.key}" must be sorted ascending by upToContextTokens`,
          });
        }
      }
      if (m.cache && m.cache.minCacheableTokens > m.contextWindow) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["models", i, "cache", "minCacheableTokens"],
          message: `minCacheableTokens of "${m.key}" exceeds its context window`,
        });
      }
    }
  });
export type PricingSnapshot = z.infer<typeof pricingSnapshotSchema>;
