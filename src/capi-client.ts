/**
 * copilot-auto — Copilot CAPI client.
 *
 * Drives the two server endpoints behind Copilot "auto":
 *   POST {base}/models/session        → session pool + Copilot-Session-Token
 *   POST {base}/models/session/intent → per-prompt routing classification
 *
 * Header construction, endpoint contract and timeouts mirror the
 * reference plugin (DESIGN.md §2.2).  The Bearer credential is injected:
 * this class never reads host auth state itself.
 */

import type { AutoSession, LoggerLike, RouterDecision } from "./types.ts";
import type { CopilotApi, EndpointDescriptor } from "./types.ts";

/** Catalog-identical wire headers (omp packages/catalog COPILOT_API_HEADERS). */
export const COPILOT_USER_AGENT = "opencode/1.3.15";
export const DEFAULT_API_VERSION = "2026-06-01";
/** Generic Copilot chat/control host. */
export const COPILOT_BASE_URL = "https://api.githubcopilot.com";
/** Account-specific Copilot host the current GPT/MAI/Gemini catalog
 *  entries are served from (live catalog: openai-responses models like
 *  mai-code-1.1-flash and gpt-5.4 use it; the CAPI control endpoints
 *  stay on the generic host). */
export const COPILOT_INDIVIDUAL_BASE_URL = "https://api.individual.githubcopilot.com";

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

export interface CapiClientOptions {
  apiVersion?: string;
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

/** True when value is one of the three supported wire API families. */
export function isCopilotApi(value: unknown): value is CopilotApi {
  return (
    value === "anthropic-messages" ||
    value === "openai-completions" ||
    value === "openai-responses"
  );
}
/** True when an api id fingerprints as the Claude family (catalog identity policy). */
export function isClaudeApiId(apiId: string): boolean {
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
export function classifyApiId(apiId: string): CopilotApi | undefined {
  if (isClaudeApiId(apiId)) return "anthropic-messages";
  if (/gemini/i.test(apiId)) return "openai-completions";
  if (/(^|[-_])(gpt|codex|mai)/i.test(apiId)) return "openai-responses";
  return undefined;
}

/** Default chat base URL for a family when no catalog metadata exists.
 *  The current Copilot GPT/MAI/Gemini catalog is served from the
 *  account-specific host; the anthropic family lives on the generic one. */
export function defaultBaseUrlFor(api: CopilotApi): string {
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
  /** Per-process identity headers (DESIGN §2.2) — generated ONCE per
   *  CapiClient, not fresh per request like a naive per-call UUID. */
  private readonly vsCodeSessionId: string;
  private readonly vsCodeMachineId: string;
  private readonly editorDeviceId: string;

  constructor(
    private readonly logger: LoggerLike,
    options: CapiClientOptions = {},
  ) {
    this.apiVersion = options.apiVersion ?? DEFAULT_API_VERSION;
    this.vsCodeSessionId = `${crypto.randomUUID()}${Date.now()}`;
    this.vsCodeMachineId = crypto.randomUUID().replace(/-/g, "");
    this.editorDeviceId = crypto.randomUUID();
  }

  /**
   * Headers shared by both CAPI calls. VS Code's @vscode/copilot-api always
   * stamps random per-process session/machine/device ids; Editor-Version /
   * Editor-Plugin-Version / Copilot-Integration-Id are omitted (reference
   * plugin keeps them commented out) — add Copilot-Integration-Id first if
   * /models/session/intent starts answering 404.
   */
  private headers(bearer: string, sessionToken?: string): Record<string, string> {
    const h: Record<string, string> = {
      Authorization: `Bearer ${bearer}`,
      "Content-Type": "application/json",
      "X-GitHub-Api-Version": this.apiVersion,
      "User-Agent": COPILOT_USER_AGENT,
      "VScode-SessionId": this.vsCodeSessionId,
      "VScode-MachineId": this.vsCodeMachineId,
      "Editor-Device-Id": this.editorDeviceId,
    };
    if (sessionToken) h["Copilot-Session-Token"] = sessionToken;
    return h;
  }

  /** POST {base}/models/session — open/refresh an auto session. */
  async fetchAutoSession(baseURL: string, bearer: string, timeoutMs?: number): Promise<AutoSession | undefined> {
    const now = Date.now();
    try {
      const response = await fetch(`${baseURL}/models/session`, {
        method: "POST",
        headers: this.headers(bearer),
        body: JSON.stringify({ auto_mode: { model_hints: ["auto"] } }),
        signal: timeoutMs ? AbortSignal.timeout(timeoutMs) : undefined,
      });
      if (!response.ok) {
        const body = await response.text().catch(() => "");
        this.logger.log(`auto session fetch non-ok: ${response.status} ${body.slice(0, 300)}`);
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
      const selectedModelID =
        typeof data.selected_model === "string" ? data.selected_model : availableModels[0];
      if (!selectedModelID) {
        this.logger.log("auto session fetch invalid payload (no selected_model and no available_models)");
        return undefined;
      }
      const discountedCosts: Record<string, number> =
        isRecord(data.discounted_costs)
          ? Object.fromEntries(
              Object.entries(data.discounted_costs).filter(
                (entry): entry is [string, number] => typeof entry[1] === "number",
              ),
            )
          : {};
      const expiresAtMs = typeof data.expires_at === "number" ? data.expires_at * 1000 : now + 30 * 60_000;
      return { selectedModelID, sessionToken: data.session_token, availableModels, discountedCosts, expiresAtMs };
    } catch (error) {
      this.logger.log(`auto session fetch failed: ${String(error)}`);
      return undefined;
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
    intentTimeoutMs: number,
  ): Promise<RouterDecision | undefined> {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), intentTimeoutMs);
    try {
      const response = await fetch(`${baseURL}/models/session/intent`, {
        method: "POST",
        headers: this.headers(bearer, sessionToken),
        body: JSON.stringify({ prompt, available_models: availableModels, ...context }),
        signal: ac.signal,
      });
      if (!response.ok) {
        const text = await response.text().catch(() => "");
        this.logger.log(`intent fetch non-ok: ${response.status} ${text.slice(0, 300)}`);
        return undefined;
      }
      // The intent response is advisory; parse it defensively like
      // fetchAutoSession so a malformed body degrades to undefined
      // (no routing happens) instead of throwing.
      const data: unknown = await response.json().catch(() => undefined);
      if (!isRecord(data)) return undefined;
      const decision: RouterDecision = {
        predicted_label:
          data.predicted_label === "needs_reasoning" || data.predicted_label === "no_reasoning"
            ? data.predicted_label
            : undefined,
        confidence: typeof data.confidence === "number" ? data.confidence : undefined,
        candidate_models: Array.isArray(data.candidate_models)
          ? data.candidate_models.filter((m): m is string => typeof m === "string")
          : undefined,
        sticky_override: typeof data.sticky_override === "boolean" ? data.sticky_override : undefined,
      };
      if (isRecord(data.scores)) {
        decision.scores = {
          needs_reasoning: typeof data.scores.needs_reasoning === "number" ? data.scores.needs_reasoning : 0,
          no_reasoning: typeof data.scores.no_reasoning === "number" ? data.scores.no_reasoning : 0,
        };
      }
      return decision;
    } catch (error) {
      this.logger.log(`intent fetch failed: ${String(error)}`);
      return undefined;
    } finally {
      clearTimeout(timer);
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
}
