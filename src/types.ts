/**
 * copilot-auto — type definitions.
 *
 * Mirrors the smart-approve convention: minimal structural surfaces for
 * the host ExtensionAPI (no @oh-my-pi import at build time) plus the
 * plugin's own domain value objects.
 */

/** Minimal logger contract for dependency injection (tests, stubs). */
export interface LoggerLike {
  log(message: string): void;
}

/** The pi/omp extension API surface used by this extension. */
export interface ExtensionAPI {
  /** Runtime discriminator (omp-wechat convention): OMP injects a
   *  truthy `pi` self-reference on the ExtensionAPI; Pi does not.
   *  Truthy → OMP, falsy/absent → Pi (see runtime-compat.ts). */
  pi?: unknown;
  on(event: string, handler: (event: unknown, ctx: ExtensionCtx) => unknown): void;
  registerCommand(name: string, def: { description: string; handler: (args: unknown, ctx: ExtensionCtx) => void | Promise<void> }): void;
  /** Structured sink into the host's own log file (best-effort). */
  logger?: { info(msg: string): void; warn(msg: string): void; error(msg: string): void };
  /** Replace a provider's model list wholesale (DESIGN §9.4). */
  registerProvider(providerId: string, config: ProviderRegistration): void;
}

/**
 * A single model entry accepted by ModelRegistry.registerProvider.
 * Structural subset: only the fields we set are declared.
 */
export interface ProviderModelEntry {
  id: string;
  name: string;
  api: CopilotApi;
  baseUrl?: string;
  contextWindow?: number;
  maxTokens?: number;
  input?: string[];
  reasoning?: boolean;
  cost?: { input: number; output: number; cacheRead: number; cacheWrite: number };
  headers?: Record<string, string>;
  compat?: Record<string, unknown>;
}

// ── chat-endpoint descriptors ───────────────────────────────────────

/**
 * Wire API families the Copilot auto shell model can anchor to. Each maps
 * to a fixed transport in the host: anthropic-messages → /v1/messages,
 * openai-completions → /chat/completions, openai-responses → /responses.
 */
export type CopilotApi = "anthropic-messages" | "openai-completions" | "openai-responses";

/**
 * A chat endpoint family: the wire API plus the base URL the transport
 * builds the request path on. Routing may only ever pick wire model ids
 * whose endpoint (api + normalized base URL) equals the registered
 * anchor's — the shell model's transport is fixed at registration
 * (DESIGN §8 within-family constraint, now endpoint-exact).
 */
export interface EndpointDescriptor {
  api: CopilotApi;
  /** Chat-endpoint base URL (no trailing slash; the anthropic anchor
   *  carries the /v1 the SDK appends /messages to). */
  baseUrl: string;
}

/**
 * Structural subset of a live host-registry Model object as returned by
 * ctx.models.list() (catalog + registered models). Only the fields the
 * endpoint anchor reads are declared.
 */
export interface CopilotCatalogModel {
  provider?: string;
  id: string;
  api?: string;
  baseUrl?: string;
  compat?: Record<string, unknown>;
}

export interface ProviderRegistration {
  baseUrl?: string;
  apiKey?: string;
  api?: string;
  headers?: Record<string, string>;
  /** OAuth-provider marker — OMP ONLY (see runtime-compat.loadPhaseOAuth).
   *  OMP's runtime registerProvider validates non-empty model lists as
   *  requiring `apiKey` or `oauth`; the marker makes the credential-less
   *  load-phase registration valid without shadowing the built-in Copilot
   *  OAuth flow (DESIGN §9.4 — no apiKey is passed at load, so the stored
   *  OAuth keeps resolving lazily). Pi's registerProvider would adapt a
   *  supplied `oauth` as a COMPLETE ExtensionOAuthConfig, so Pi receives
   *  NO marker and inherits its built-in `github-copilot` OAuth. */
  oauth?: { name?: string };
  /** Provider-level compat forwarded by the host's registerProvider into
   *  the model builder (sOe(..., t.compat, ..., model)). Model-entry
   *  flags like `disableStrictTools` are NOT consumed there, so strict
   *  tool control must ride here (DESIGN §9.4). */
  compat?: Record<string, unknown>;
  models?: ProviderModelEntry[];
}

export interface ExtensionCtx {
  hasUI: boolean;
  cwd?: string;
  sessionManager?: { getSessionId?: () => string | undefined };
  modelRegistry?: {
    getApiKeyForProvider(providerId: string, sessionId?: string, opts?: unknown): Promise<string | undefined>;
    /** Pi fallback: resolves the provider's current auth (stored OAuth /
     *  api key) when getApiKeyForProvider is absent or fails. Never
     *  log the returned credential. */
    getProviderAuth?(providerId: string): Promise<{ auth?: { apiKey?: string } } | undefined>;
    /** Pi registry snapshot: full Model list ({ provider, id, api,
     *  baseUrl, … }). Catalog adapter fallback when ctx.models is
     *  absent (see runtime-compat.catalogModelEntries). */
    getAll?(): CopilotCatalogModel[];
    /** Trigger the host's background catalog refresh (idempotent).
     *  Present on the live ModelRegistry; used to ensure ctx.models.list()
     *  reflects the account's current catalog before anchoring. */
    refreshInBackground?(mode?: string): void;
    /** Resolve when an in-flight background refresh settles. */
    awaitBackgroundRefresh?(): Promise<void>;
  };
  /** Live host registry access: list() returns the current catalog +
   *  registered models (provider, id, api, baseUrl, compat, …). Present
   *  from session_start on; used to map pool ids to endpoint metadata. */
  models?: {
    list(): CopilotCatalogModel[];
  };
  /** Pi: session-scoped model entries ({ model: { provider, id, api,
   *  baseUrl, … }, thinkingLevel? }) — the same set /scoped-models
   *  shows. Catalog adapter fallback when ctx.models is absent. */
  scopedModels?: readonly { model: CopilotCatalogModel }[];
  ui: {
    setStatus(id: string, text: string | undefined): void;
    notify?(msg: string, level: "info" | "warning"): void;
  };
}

// ── Copilot CAPI value objects ───────────────────────────────────────

/** Parsed POST /models/session response — one per conversation × auto model. */
export interface AutoSession {
  selectedModelID: string;
  sessionToken: string;
  availableModels: string[];
  discountedCosts: Record<string, number>;
  expiresAtMs: number;
}

/** Shape of POST /models/session/intent (intent router) response. */
export interface RouterDecision {
  predicted_label?: "needs_reasoning" | "no_reasoning";
  confidence?: number;
  candidate_models?: string[];
  scores?: { needs_reasoning: number; no_reasoning: number };
  sticky_override?: boolean;
}

/** Routing label produced by the intent router. */
export type RouteLabel = "needs_reasoning" | "no_reasoning" | undefined;

/** Per-conversation routing/session state (see DESIGN.md §2.4/§7). */
export interface ConvState {
  session?: AutoSession;
  /** Single-flight promise so same-turn callers share one open/refresh. */
  sessionInflight?: Promise<AutoSession | undefined>;
  lastPrompt?: string;
  referenceCount?: number;
  routedModelID?: string;
  routedLabel?: RouteLabel;
  /** Intent-router confidence of the committed route (DESIGN §9.5 logs). */
  routedConfidence?: number;
  needsReEval?: boolean;
  /** True when the decided model is outside the session pool: send WITHOUT token. */
  omitSessionToken?: boolean;
  previousModel?: string;
  turn: number;
}

// ── wire-payload hooks ───────────────────────────────────────────────

/** The provider-request body as seen by before_provider_request. */
export interface WirePayload {
  model?: string;
  /** Anthropic thinking budget — boost-only, written on needs_reasoning turns. */
  thinking?: { type: "enabled"; budget_tokens: number };
  /** OpenAI chat-completions reasoning effort — boost-only, written on
   *  needs_reasoning turns for openai-completions anchors. */
  reasoning_effort?: "high";
  /** OpenAI responses reasoning block — boost-only for openai-responses
   *  anchors; extra fields (include, enabled, …) are preserved. */
  reasoning?: { effort?: string; summary?: string; [k: string]: unknown };
  [k: string]: unknown;
}

// ── Plugin options ───────────────────────────────────────────────────

export interface CopilotAutoOptions {
  /** Api-version header value mirrored from the OMP catalog. */
  apiVersion?: string;
  /** Refresh a session token this long before server expiry (ms). */
  refreshSkewMs?: number;
  /** Intent-router hard abort (ms). VS Code mirrors 1s. */
  intentTimeoutMs?: number;
  /** Catalog-level probe timeout used to pick the anchor endpoint (ms). */
  probeTimeoutMs?: number;
  /** Enable per-turn status bar updates (default true). */
  statusBar?: boolean;
}
