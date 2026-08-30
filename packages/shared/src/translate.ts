/**
 * The dialect-translation contract: one request, shown at all three stages it
 * passes through on its way upstream.
 *
 * rewter accepts two downstream dialects and speaks three upstream ones, and
 * every bug in that mesh looks the same from outside — "the model got something
 * I didn't send". This endpoint answers that question directly: paste the
 * request a client made, see the `ChatMessage[]` it normalizes to, and see the
 * exact body the chosen provider would receive.
 *
 * It sends nothing. The upstream stage comes from `describeRequest`, which is
 * the same builder `stream()` uses (and is pinned to it by per-adapter
 * equivalence tests), so the panel cannot describe a request nobody would send.
 */
import { z } from "zod";
import {
  ChatMessageSchema,
  FinishReasonSchema,
  ToolDefinitionSchema,
  UsageSchema,
} from "./chat.js";
import { ProviderKindSchema } from "./entities.js";

/** Which downstream dialect the pasted body is written in. */
export const TranslateDialectSchema = z.enum(["openai", "anthropic"]);
export type TranslateDialect = z.infer<typeof TranslateDialectSchema>;

export const TranslateRequestSchema = z.object({
  dialect: TranslateDialectSchema,
  /**
   * The client's raw request. Validated server-side against that dialect's own
   * schema — the same one the real route uses, so a body this endpoint rejects
   * is a body `/v1/chat/completions` would have rejected too.
   */
  body: z.unknown(),
});
export type TranslateRequest = z.infer<typeof TranslateRequestSchema>;

/** Stage two: what both dialects converge on before routing. */
export const NormalizedRequestSchema = z.object({
  model: z.string(),
  messages: z.array(ChatMessageSchema),
  tools: z.array(ToolDefinitionSchema).optional(),
  maxTokens: z.number().optional(),
  temperature: z.number().optional(),
});
export type NormalizedRequest = z.infer<typeof NormalizedRequestSchema>;

/** Where the request would have gone. Null when the model does not resolve. */
export const TranslateResolutionSchema = z.object({
  modelId: z.string(),
  providerId: z.string(),
  providerName: z.string(),
  providerKind: ProviderKindSchema,
  /** The id that actually goes on the wire, which may differ from our slug. */
  upstreamId: z.string(),
  baseUrl: z.string().nullable(),
});
export type TranslateResolution = z.infer<typeof TranslateResolutionSchema>;

/**
 * Stage three. Never contains credentials: keys ride in headers (or, for
 * Google, a query parameter) that the SDK attaches at call time, so there is
 * nothing in a body to redact.
 */
export const UpstreamRequestSchema = z.object({
  kind: ProviderKindSchema,
  path: z.string(),
  body: z.record(z.unknown()),
});

export const TranslateResponseSchema = z.object({
  dialect: TranslateDialectSchema,
  normalized: NormalizedRequestSchema,
  resolution: TranslateResolutionSchema.nullable(),
  upstream: UpstreamRequestSchema.nullable(),
  /**
   * Why the upstream stage is missing, when it is — an unknown model, a
   * disabled provider, or `auto/orchestrator`, which fans out to many upstream
   * calls and so has no single body to show. Null when nothing is missing.
   */
  note: z.string().nullable(),
});
export type TranslateResponse = z.infer<typeof TranslateResponseSchema>;

/**
 * The chat tester: one prompt, one model, actually sent.
 *
 * The deliberate opposite of everything above. Describing proves the *shape* is
 * right; it cannot prove the key works, the base URL is current, or the model
 * id is one the upstream recognises. The provider probe answers the first two
 * for free — but a catalog read is not a completion, and six presets expose no
 * catalog at all, so `untestable` is where a real check has been stopping.
 *
 * This spends money, and so it says so. Every field below exists to make the
 * cost visible after the fact (`usage`, `costUsd`) and small before it
 * (`maxTokens` defaults low): a tester that hides what it billed is a tester
 * people use once and then distrust.
 */
export const ChatTestRequestSchema = z.object({
  model: z.string().min(1),
  prompt: z.string().min(1),
  /**
   * Capped low and defaulted lower. This is a "does it answer" button, not a
   * chat window — the useful answer arrives in a sentence, and the ceiling is
   * what keeps a mistyped box from becoming a bill.
   */
  maxTokens: z.number().int().positive().max(1000).default(256),
  temperature: z.number().min(0).max(2).optional(),
});
export type ChatTestRequest = z.infer<typeof ChatTestRequestSchema>;

export const ChatTestResultSchema = z.object({
  modelId: z.string(),
  /** What the model said. Empty is a real answer, and a suspicious one. */
  text: z.string(),
  finishReason: FinishReasonSchema,
  usage: UsageSchema,
  /**
   * Computed from the same pricing snapshot the router records with, so this
   * number and the spend panel's cannot disagree. Null when the model is
   * unpriced — distinct from `0`, which means priced at zero.
   */
  costUsd: z.number().nullable(),
  latencyMs: z.number().int().nonnegative(),
});
export type ChatTestResult = z.infer<typeof ChatTestResultSchema>;
