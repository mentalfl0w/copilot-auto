/**
 * copilot-auto — Copilot CAPI client.
 *
 * Drives the Copilot Auto session/intent control endpoints:
 *   POST {base}/models/session        → Auto pool + session token
 *   POST {base}/models/session/intent → per-prompt model classification
 * Header construction, endpoint contract and timeouts mirror the
 * reference plugin (DESIGN.md §2.2).  The Bearer credential is injected:
 * this class never reads host auth state itself.
 */

import type {
  AutoSession,
  LoggerLike,
  ReasoningBucket,
  RouterDecision,
  SelectedModelMetadata,
} from "./types.ts";
import type { CopilotApi, EndpointDescriptor } from "./types.ts";

/** Copilot Chat request profile mirrored from the upstream Pi adapter. */
export const DEFAULT_API_VERSION = "2026-06-01";
export const COPILOT_USER_AGENT = "GitHubCopilotChat/0.35.0";
export const COPILOT_EDITOR_VERSION = "vscode/1.107.0";
export const COPILOT_EDITOR_PLUGIN_VERSION = "copilot-chat/0.35.0";
export const COPILOT_INTEGRATION_ID = "vscode-chat";
export const COPILOT_OPENAI_INTENT = "conversation-edits";
export const COPILOT_HEADERS: Readonly<Record<string, string>> = {
  Accept: "application/json",
  "Content-Type": "application/json",
  "User-Agent": COPILOT_USER_AGENT,
  "Editor-Version": COPILOT_EDITOR_VERSION,
  "Editor-Plugin-Version": COPILOT_EDITOR_PLUGIN_VERSION,
  "Copilot-Integration-Id": COPILOT_INTEGRATION_ID,
  "X-GitHub-Api-Version": DEFAULT_API_VERSION,
  "Openai-Intent": COPILOT_OPENAI_INTENT,
};
/** Timeout for opening or refreshing a session. */
export const DEFAULT_SESSION_OPEN_TIMEOUT_MS = 15_000;
/** Timeout for the advisory intent request. */
const DEFAULT_INTENT_TIMEOUT_MS = 1_000;
/** Generic Copilot chat/control host. */
export const COPILOT_BASE_URL = "https://api.githubcopilot.com";
/** Account-specific Copilot host the current GPT/MAI/Gemini catalog
 *  entries are served from (live catalog: openai-responses models like
 *  mai-code-1.1-flash and gpt-5.4 use it; the CAPI control endpoints
 *  stay on the generic host). */
const COPILOT_INDIVIDUAL_BASE_URL = "https://api.individual.githubcopilot.com";

/**
 * Load-phase / probe-failure default anchor. openai-responses is the
 * current Copilot GPT/MAI catalog family (mai-code-1.1-flash, gpt-5.4,
 * …) — the old openai-completions default is exactly what sent
 * mai-code-1.1-flash to /chat/completions. Re-anchored from the session
 * pool + catalog metadata at session_start.
 */
export const DEFAULT_COPILOT_DESCRIPTOR: EndpointDescriptor = {
  api: "openai-responses",
  baseUrl: COPILOT_INDIVIDUAL_BASE_URL,
};

interface CapiClientOptions {
  apiVersion?: string;
  /** /models/session timeout when a call does not override it. */
  sessionOpenTimeoutMs?: number;
}

/**
 * Strip trailing slashes and a trailing /v1 so Claude-family template urls
 * (https://api.githubcopilot.com/v1) resolve to the CAPI root.
 */
export function capiBase(url: string): string {
  return url.replace(/\/+$/, "").replace(/\/v1$/, "");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function parseSelectedModel(value: unknown): SelectedModelMetadata | undefined {
  if (!isRecord(value) || typeof value.id !== "string" || value.id.trim().length === 0) return undefined;
  return { ...value, id: value.id };
}

function parseNumberRecord(value: unknown): Record<string, number> | undefined {
  if (!isRecord(value)) return undefined;
  return Object.fromEntries(
    Object.entries(value).filter((entry): entry is [string, number] => isFiniteNumber(entry[1])),
  );
}

function parseStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter((item): item is string => typeof item === "string");
}

function parseString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function parseReasoningBucket(value: unknown): ReasoningBucket | undefined {
  return value === "low" || value === "medium" || value === "high" ? value : undefined;
}

/** OMP stores GitHub Copilot OAuth as a JSON envelope; CAPI needs its token. */
function bearerToken(value: string): string {
  try {
    const parsed: unknown = JSON.parse(value);
    if (isRecord(parsed)) {
      const token = parseString(parsed.token);
      if (token) return token;
    }
  } catch {}
  return value;
}

function timeoutValue(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  return isFiniteNumber(value) ? Math.max(0, value) : fallback;
}

interface AbortLease {
  signal: AbortSignal;
  dispose(): void;
}

/** Merge caller cancellation with a hard deadline without AbortSignal.any(). */
function mergeAbortSignal(callerSignal: AbortSignal | undefined, timeoutMs: number): AbortLease {
  const controller = new AbortController();
  const timer: ReturnType<typeof setTimeout> = setTimeout(() => controller.abort(), timeoutMs);
  const onCallerAbort = (): void => controller.abort();

  if (callerSignal) {
    if (callerSignal.aborted) {
      controller.abort();
    } else {
      callerSignal.addEventListener("abort", onCallerAbort, { once: true });
    }
  }

  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timer);
      callerSignal?.removeEventListener("abort", onCallerAbort);
    },
  };
}

function errorKind(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}


/** True when value is one of the three supported wire API families. */
export function isCopilotApi(value: unknown): value is CopilotApi {
  return (
    value === "anthropic-messages" ||
    value === "openai-completions" ||
    value === "openai-responses"
  );
}
/** True when an api id fingerprints as the Claude family (catalog identity policy). */
function isClaudeApiId(apiId: string): boolean {
  return /claude/i.test(apiId);
}

/**
 * Conservative heuristic classification for pool ids with NO catalog
 * metadata (DESIGN §9.4): Claude → anthropic-messages; gemini →
 * openai-completions; gpt/codex/mai → openai-responses. Unknown families
 * (grok, future ids, …) return undefined — they are NOT eligible for
 * token-stamped routing or anchoring until their endpoint is known. Never
 * classify an id into a family the catalog does not use for it.
 */
function classifyApiId(apiId: string): CopilotApi | undefined {
  if (isClaudeApiId(apiId)) return "anthropic-messages";
  if (/gemini/i.test(apiId)) return "openai-completions";
  if (/(^|[-_])(gpt|codex|mai)/i.test(apiId)) return "openai-responses";
  return undefined;
}

/** Default chat base URL for a family when no catalog metadata exists.
 *  The current Copilot GPT/MAI/Gemini catalog is served from the
 *  account-specific host; the anthropic family lives on the generic one. */
function defaultBaseUrlFor(api: CopilotApi): string {
  switch (api) {
    case "anthropic-messages":
      return COPILOT_BASE_URL;
    case "openai-completions":
    case "openai-responses":
      return COPILOT_INDIVIDUAL_BASE_URL;
  }
}

/**
 * Chat-endpoint descriptor for one pool id: catalog metadata first, then
 * the explicit heuristic (family + its default base URL). Undefined when
 * the endpoint is unknown — such ids are excluded from anchoring and from
 * token-stamped routing.
 */
export function descriptorForId(
  apiId: string,
  catalog: ReadonlyMap<string, EndpointDescriptor>,
): EndpointDescriptor | undefined {
  const known = catalog.get(apiId);
  if (known) return known;
  const api = classifyApiId(apiId);
  return api ? { api, baseUrl: defaultBaseUrlFor(api) } : undefined;
}

/**
 * Normalized identity of a chat endpoint family: api + base URL with the
 * trailing /v1 (anthropic) and slashes normalized away, so the anthropic
 * catalog entry (root) and the registered shell model (/v1) compare equal.
 */
export function endpointKey(descriptor: EndpointDescriptor): string {
  return `${descriptor.api}::${capiBase(descriptor.baseUrl)}`;
}

export class CapiClient {
  private readonly apiVersion: string;
  private readonly sessionOpenTimeoutMs: number;

  constructor(
    private readonly logger: LoggerLike,
    options: CapiClientOptions = {},
  ) {
    this.apiVersion = options.apiVersion ?? DEFAULT_API_VERSION;
    this.sessionOpenTimeoutMs = timeoutValue(options.sessionOpenTimeoutMs, DEFAULT_SESSION_OPEN_TIMEOUT_MS);
  }

  /**
   * Headers shared by CAPI calls. Bearer/session credentials stay in the
   * request only; this client never logs or stores them.
   */
  private headers(
    bearer: string,
    sessionToken?: string,
    interactionId?: string,
  ): Record<string, string> {
    const h: Record<string, string> = {
      ...COPILOT_HEADERS,
      Authorization: `Bearer ${bearerToken(bearer)}`,
      "X-GitHub-Api-Version": this.apiVersion,
      "X-Initiator": "user",
    };
    if (sessionToken) h["Copilot-Session-Token"] = sessionToken;
    if (interactionId) h["X-Interaction-Id"] = interactionId;
    return h;
  }

  /**
   * POST {base}/models/session — open/refresh an auto session.
   * The optional timeout and caller signal are merged with the hard deadline.
   */
  async fetchAutoSession(
    baseURL: string,
    bearer: string,
    timeoutMs?: number,
    callerSignal?: AbortSignal,
  ): Promise<AutoSession | undefined> {
    const resolvedTimeoutMs = timeoutValue(timeoutMs, this.sessionOpenTimeoutMs);
    const lease = mergeAbortSignal(callerSignal, resolvedTimeoutMs);
    const now = Date.now();
    const interactionId = crypto.randomUUID();
    try {
      if (callerSignal?.aborted) return undefined;
      const response = await fetch(`${baseURL}/models/session`, {
        method: "POST",
        headers: this.headers(bearer, undefined, interactionId),
        body: JSON.stringify({ auto_mode: { model_hints: ["auto"] } }),
        signal: lease.signal,
      });
      if (!response.ok) {
        await response.text().catch(() => "");
        this.logger.log(`auto session fetch non-ok: ${response.status}`);
        return undefined;
      }
      const data: unknown = await response.json().catch(() => undefined);
      if (!isRecord(data) || typeof data.session_token !== "string") {
        this.logger.log("auto session fetch invalid payload (missing session_token)");
        return undefined;
      }
      const availableModels = Array.isArray(data.available_models)
        ? data.available_models.filter((m): m is string => typeof m === "string")
        : [];
      const selectedModel = parseSelectedModel(data.selected_model);
      const selectedModelID =
        parseString(data.selected_model) ??
        selectedModel?.id ??
        parseString(data.chosen_model) ??
        availableModels[0];
      if (!selectedModelID) {
        this.logger.log("auto session fetch invalid payload (no selected_model and no available_models)");
        return undefined;
      }
      const discountedCosts = parseNumberRecord(data.discounted_costs) ?? {};
      const hydraScores = parseNumberRecord(data.hydra_scores);
      const expiresAtMs = isFiniteNumber(data.expires_at)
        ? data.expires_at * 1000
        : now + 30 * 60_000;
      const session: AutoSession = {
        selectedModelID,
        sessionToken: data.session_token,
        interactionId,
        availableModels,
        discountedCosts,
        expiresAtMs,
      };
      if (selectedModel) session.selectedModel = selectedModel;
      if (hydraScores) session.hydraScores = hydraScores;
      return session;
    } catch (error) {
      this.logger.log(`auto session fetch failed (${errorKind(error)})`);
      return undefined;
    } finally {
      lease.dispose();
    }
  }

  /**
   * POST {base}/models/session/intent — classify the prompt. Hard abort at
   * intentTimeoutMs (VS Code behavior); failure is non-fatal by design.
   */
  async getRouterDecision(
    baseURL: string,
    bearer: string,
    sessionToken: string,
    prompt: string,
    availableModels: string[],
    context: IntentContext,
    intentTimeoutMs: number = DEFAULT_INTENT_TIMEOUT_MS,
    interactionId?: string,
  ): Promise<RouterDecision | undefined> {
    const lease = mergeAbortSignal(undefined, timeoutValue(intentTimeoutMs, DEFAULT_INTENT_TIMEOUT_MS));
    const requestInteractionId = interactionId ?? crypto.randomUUID();
    try {
      const response = await fetch(`${baseURL}/models/session/intent`, {
        method: "POST",
        headers: this.headers(bearer, sessionToken, requestInteractionId),
        body: JSON.stringify({ prompt, available_models: availableModels, ...context }),
        signal: lease.signal,
      });
      if (!response.ok) {
        await response.text().catch(() => "");
        this.logger.log(`intent fetch non-ok: ${response.status}`);
        return undefined;
      }
      // The intent response is advisory; parse the two observed
      // session/intent dialects: upstream uses chosen_model/reasoning_bucket,
      // while the alternate client uses selected_model/predicted_label.
      const data: unknown = await response.json().catch(() => undefined);
      if (!isRecord(data)) return undefined;
      const candidateModels = parseStringArray(data.candidate_models);
      const decision: RouterDecision = {
        predicted_label:
          data.predicted_label === "needs_reasoning" || data.predicted_label === "no_reasoning"
            ? data.predicted_label
            : undefined,
        confidence: isFiniteNumber(data.confidence) ? data.confidence : undefined,
        candidate_models: candidateModels,
      };
      const reasoningBucket = parseReasoningBucket(data.reasoning_bucket);
      if (reasoningBucket) decision.reasoning_bucket = reasoningBucket;
      const chosenModel = parseString(data.chosen_model);
      if (chosenModel) decision.chosen_model = chosenModel;
      const selectedModel = parseString(data.selected_model);
      if (selectedModel) decision.selected_model = selectedModel;
      return decision;
    } catch (error) {
      this.logger.log(`intent fetch failed (${errorKind(error)})`);
      return undefined;
    } finally {
      lease.dispose();
    }
  }
}

/** Conversation-context fields appended to the intent request body. */
export interface IntentContext {
  session_id?: string;
  turn_number?: number;
  previous_model?: string;
  reference_count?: number;
  prompt_char_count?: number;
  has_image?: boolean;
}
