import { z } from "zod";

/**
 * Rebuilds an object schema so unknown keys are PASSED THROUGH instead of
 * rejected, recursively - nested section objects included. Optional and
 * nullable wrappers are unwrapped, their inner object rebuilt, and the
 * wrapper re-applied, so the reconstructed schema accepts the same values
 * as the original plus unknown keys at every object level.
 *
 * Used by the host adapters on the accept-then-teach guard tools only: a
 * typo'd key ("labels" for "label", a typo'd config_set field) must
 * survive host validation and reach the tool's execute, which answers with
 * "did you mean" teaching (src/fuzzy.ts). Value validation (enums, nulls,
 * types) is untouched - only unknown-KEY handling loosens. Never apply
 * this to a DECLARED schema for a non-guard tool: the declared surface is
 * the honest contract (strict for non-guard tools), and a permissive
 * additionalProperties leaks an index signature into the Code Mode
 * catalog's rendered signatures.
 */
export function deepPassthrough(schema: z.ZodObject<any>): z.ZodObject<any> {
  const shape: Record<string, z.ZodType> = {};
  for (const [key, value] of Object.entries(schema.shape) as [string, z.ZodType][]) {
    shape[key] = passthroughInner(value);
  }
  return z.object(shape).loose();
}

function passthroughInner(schema: z.ZodType): z.ZodType {
  if (schema instanceof z.ZodOptional) return z.optional(passthroughInner(schema.unwrap() as z.ZodType));
  if (schema instanceof z.ZodNullable) return z.nullable(passthroughInner(schema.unwrap() as z.ZodType));
  if (schema instanceof z.ZodObject) return deepPassthrough(schema);
  return schema;
}
