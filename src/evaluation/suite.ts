import { createHash } from "node:crypto";
import { z } from "zod";
import { JevError } from "../core/errors.js";
import { inputSchema as rankInput } from "../recipes/rank-candidates.js";
import { inputSchema as verifyInput } from "../recipes/verify-claims.js";
import { inputSchema as triageInput } from "../recipes/triage-failure.js";

export const identifier = z.string().trim().min(1).max(128);
export const version = z.string().trim().min(1).max(100);
export const modelName = z.string().trim().min(1).max(200);
export const category = z.enum(["regression", "environment", "dependency", "flaky", "unknown"]);
const header = {
  schemaVersion: z.literal(1), suite: identifier, suiteVersion: version, recipeVersion: version,
};
const rankSample = z.object({
  id: identifier, input: rankInput,
  expected: z.object({ keyIds: z.array(identifier).min(1).max(50), topK: z.number().int().min(1).max(50) }).strict(),
}).strict().refine(({ input, expected }) =>
  new Set(expected.keyIds).size === expected.keyIds.length
  && expected.keyIds.every(id => input.candidates.some(item => item.id === id))
  && expected.topK <= input.candidates.length);
const verifySample = z.object({
  id: identifier, input: verifyInput,
  expected: z.object({ claims: z.array(z.object({
    id: identifier, verdict: z.enum(["supported", "contradicted", "insufficient"]),
  }).strict()).min(1).max(50) }).strict(),
}).strict().refine(({ input, expected }) =>
  new Set(expected.claims.map(c => c.id)).size === expected.claims.length
  && expected.claims.length === input.claims.length
  && expected.claims.every(c => input.claims.some(item => item.id === c.id)));
const triageSample = z.object({
  id: identifier, input: triageInput, expected: z.object({ category }).strict(),
}).strict();

export const suiteSchema = z.discriminatedUnion("recipeId", [
  z.object({ ...header, recipeId: z.literal("rank-candidates"), samples: z.array(rankSample).min(1).max(1_000) }).strict(),
  z.object({ ...header, recipeId: z.literal("verify-claims"), samples: z.array(verifySample).min(1).max(1_000) }).strict(),
  z.object({ ...header, recipeId: z.literal("triage-failure"), samples: z.array(triageSample).min(1).max(1_000) }).strict(),
]).refine(suite => new Set(suite.samples.map(s => s.id)).size === suite.samples.length);
export type Suite = z.infer<typeof suiteSchema>;
export type RecipeId = Suite["recipeId"];

export function parseSuite(value: unknown): Suite {
  const result = suiteSchema.safeParse(value);
  if (!result.success) throw new JevError("INVALID_INPUT", "Invalid labeled suite; check the documented schema, IDs, labels and bounds.");
  return result.data;
}

/** JSONL is one strict header followed by sample objects. No directory discovery. */
export function parseSuiteText(text: string): Suite {
  let value: unknown;
  try { value = JSON.parse(text); }
  catch {
    try {
      const [head, ...samples] = text.split(/\r?\n/).filter(line => line.trim()).map(line => JSON.parse(line) as unknown);
      if (!head || typeof head !== "object" || Array.isArray(head) || Object.hasOwn(head, "samples")) throw new Error();
      value = { ...head, samples };
    } catch { throw new JevError("INVALID_INPUT", "Cannot parse suite JSON or header-first JSONL."); }
  }
  return parseSuite(value);
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/** Excludes recipeVersion so the same labels can compare different rule versions. */
export function suiteDigest(suite: Suite, samples = suite.samples): string {
  return createHash("sha256").update(canonical({ schemaVersion: suite.schemaVersion, suite: suite.suite,
    suiteVersion: suite.suiteVersion, recipeId: suite.recipeId, samples })).digest("hex");
}
