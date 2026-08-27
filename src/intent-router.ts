/**
 * copilot-auto — intent router + model selection policy.
 *
 * Given a conversation's session pool and the routing verdict from
 * POST /models/session/intent, pick the outgoing wire model id and the
 * reasoning-boost options. Selection stays inside the anchor ENDPOINT
 * (the shell model's fixed transport — wire API + base URL); sticky
 * caching lives in ConvState.
 *
 * Endpoint policy (DESIGN §8, now endpoint-exact): a pool id is eligible
 * when its chat endpoint — catalog metadata first, then the explicit
 * conservative heuristic (claude → anthropic-messages, gemini →
 * openai-completions, gpt/codex/mai → openai-responses) — equals the
 * anchor's api + normalized base URL. Unknown ids (no catalog entry, no
 * heuristic match) are never eligible for token-stamped routing; a
 * responses-family id is never sent to chat-completions and vice versa.
 */

import { capiBase, descriptorForId, endpointKey } from "./capi-client.ts";
import type { CapiClient, IntentContext } from "./capi-client.ts";
import type { AutoSession, ConvState, EndpointDescriptor, LoggerLike, RouteLabel, WirePayload } from "./types.ts";

export interface RoutingVerdict {
  decided: string;
  label: RouteLabel;
  /** Intent-router confidence, when the verdict came from the intent endpoint. */
  confidence?: number;
  /** True when `decided` is NOT in the session pool → send without token. */
  omitSessionToken: boolean;
  source: "sticky" | "intent" | "fallback";
}

export interface IntentRouterOptions {
  intentTimeoutMs?: number;
  /** Anthropic thinking budget for needs_reasoning turns (default 16000). */
  anthropicBudgetTokens?: number;
}

const DEFAULT_INTENT_TIMEOUT_MS = 1_000;
const DEFAULT_ANTHROPIC_BUDGET_TOKENS = 16_000;

/**
 * Last-resort wire ids when no session exists and the pool default /
 * selected model are unavailable. MUST match the anchor endpoint family:
 * the shell model's transport is fixed to that endpoint at registration,
 * so a cross-family id would go to the wrong wire API (the reported
 * mai-code-1.1-flash → /chat/completions 400). For openai-completions the
 * host varies with the anchor base URL (both Copilot hosts serve
 * completions models; only the matching one accepts the wire id).
 */
function fallbackModelFor(descriptor: EndpointDescriptor): string {
  switch (descriptor.api) {
    case "anthropic-messages":
      return "claude-sonnet-4-6";
    case "openai-responses":
      return "gpt-5.4";
    case "openai-completions":
      return capiBase(descriptor.baseUrl).includes("individual") ? "gpt-4.1" : "gemini-2.5-pro";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export class IntentRouter {
  private readonly intentTimeoutMs: number;
  private readonly anthropicBudgetTokens: number;

  constructor(
    private readonly client: CapiClient,
    private readonly logger: LoggerLike,
    private readonly descriptor: EndpointDescriptor,
    options: IntentRouterOptions = {},
    /** Endpoint metadata captured at registration (catalog + registered
     *  models, provider github-copilot): resolves pool ids to wire
     *  endpoints. Unknown ids fall back to the explicit heuristic. */
    private readonly catalog: ReadonlyMap<string, EndpointDescriptor> = new Map(),
  ) {
    this.intentTimeoutMs = options.intentTimeoutMs ?? DEFAULT_INTENT_TIMEOUT_MS;
    this.anthropicBudgetTokens = options.anthropicBudgetTokens ?? DEFAULT_ANTHROPIC_BUDGET_TOKENS;
  }

  /** True when an api id's known endpoint equals this router's anchor
   *  endpoint (api + normalized base URL). Unknown ids are never
   *  eligible — they cannot be token-stamped safely. */
  matchesEndpoint(apiId: string): boolean {
    const endpoint = descriptorForId(apiId, this.catalog);
    return endpoint !== undefined && endpointKey(endpoint) === endpointKey(this.descriptor);
  }

  /** First pool entry of the anchor endpoint — the no-routing default. */
  defaultPoolModel(session: AutoSession | undefined): string | undefined {
    return session?.availableModels.find((id) => this.matchesEndpoint(id));
  }

  /**
   * The no-routing default, endpoint-clamped: prefer the first
   * same-endpoint pool entry, then the server's selected model when its
   * endpoint is known to match, then the hardcoded endpoint fallback.
   * Never emits a wire id from another endpoint (api family or host).
   */
  private endpointDefault(session: AutoSession | undefined): string {
    const poolDefault = this.defaultPoolModel(session);
    if (poolDefault) return poolDefault;
    if (session?.selectedModelID && this.matchesEndpoint(session.selectedModelID)) {
      return session.selectedModelID;
    }
    return fallbackModelFor(this.descriptor);
  }

  /**
   * Full per-turn decision. Sticky: after turn-0 succeeds the verdict is
   * reused until compaction (needsReEval), matching VS Code's KV-cache
   * stability behavior. Falls back to the pool default when the router is
   * unavailable; out-of-pool decisions drop the session token.
   */
  async decideTurn(args: {
    conv: ConvState;
    sessionId: string;
    baseURL: string;
    bearer: string | undefined;
    prompt: string | undefined;
  }): Promise<RoutingVerdict> {
    const { conv, sessionId, baseURL, bearer, prompt } = args;
    const root = capiBase(baseURL);
    const session = conv.session;

    // Sticky path: reuse the cached pick unless compaction invalidated it.
    if (conv.routedModelID !== undefined && !conv.needsReEval) {
      return {
        decided: conv.routedModelID,
        label: conv.routedLabel,
        confidence: conv.routedConfidence,
        omitSessionToken: !this.inPoolOrDefault(session, conv.routedModelID),
        source: "sticky",
      };
    }

    // Turn-0 / post-compaction: ask the intent router when we can.
    const fallback = this.endpointDefault(session);
    let decided = fallback;
    let label: RouteLabel = undefined;
    let confidence: number | undefined;
    let source: RoutingVerdict["source"] = "fallback";

    if (session?.sessionToken && bearer && prompt && session.availableModels.length > 0) {
      const context: IntentContext = {
        session_id: sessionId,
        turn_number: conv.turn + 1,
        previous_model: conv.previousModel,
        reference_count: conv.referenceCount,
        prompt_char_count: prompt.length,
      };
      const decision = await this.client.getRouterDecision(
        root, bearer, session.sessionToken, prompt, session.availableModels, context, this.intentTimeoutMs,
      );
      const candidates = (decision?.candidate_models ?? []).filter((id) => this.matchesEndpoint(id));
      if (candidates.length > 0) {
        decided = candidates[0];
        label = decision?.predicted_label;
        confidence = decision?.confidence;
        source = "intent";
        this.logger.log(
          `intent routed -> ${decided} (top=${candidates[0]}, label=${label}, confidence=${decision?.confidence})`,
        );
      } else {
        this.logger.log(`intent gave no same-endpoint candidates; keeping ${decided}`);
      }
    } else {
      this.logger.log(`routing skipped (session=${Boolean(session)}, prompt=${Boolean(prompt)}) -> ${decided}`);
    }

    // Pool-missing degradation (DESIGN §2.3): a decided model outside the
    // pool goes out without a session token.
    return { decided, label, confidence, omitSessionToken: !this.inPoolOrDefault(session, decided), source };
  }

  /**
   * Boost-only reasoning shaping for needs_reasoning turns. Never lowers
   * effort on fast turns. Writes directly into the wire payload, keyed to
   * the anchor endpoint's API family (the shell model's fixed transport):
   * anthropic-messages → thinking budget, openai-completions →
   * reasoning_effort, openai-responses → reasoning { effort, summary }.
   */
  applyReasoningBoost(payload: WirePayload, apiId: string, label: RouteLabel): void {
    if (label !== "needs_reasoning") return;
    switch (this.descriptor.api) {
      case "anthropic-messages":
        payload.thinking = { type: "enabled", budget_tokens: this.anthropicBudgetTokens };
        break;
      case "openai-completions":
        payload.reasoning_effort = "high";
        break;
      case "openai-responses": {
        // Preserve any existing reasoning fields (include, enabled, …);
        // never leave a stale chat-completions effort on a responses body.
        const existing = payload.reasoning;
        payload.reasoning = {
          ...(isRecord(existing) ? existing : {}),
          effort: "high",
          summary: "auto",
        };
        delete payload.reasoning_effort;
        break;
      }
    }
    this.logger.log(`reasoning boost applied -> ${apiId} (${this.descriptor.api})`);
  }

  private inPoolOrDefault(session: AutoSession | undefined, apiId: string): boolean {
    if (!session) return true;
    return session.availableModels.includes(apiId);
  }
}
