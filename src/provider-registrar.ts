/**
 * copilot-auto — provider registrar.
 *
 * Registers the single `github-copilot/auto` shell model by replacing the
 * builtin provider's model list wholesale (edu accounts cannot use those
 * catalog models anyway). The anchor ENDPOINT (wire API + base URL) is
 * derived from the session pool + host catalog metadata first, so the
 * shell model's transport matches the pool: the probe result seeds the
 * session cache of the session it was minted for (tokens are
 * conversation-scoped — other sessions open their own).
 *
 * Key invariants (DESIGN.md §9.4):
 *   - provider id stays "github-copilot" → all stored-OAuth lookups and
 *     copilot compat probing keep working unchanged;
 *   - LOAD-PHASE registration (registerDefault) makes the model resolvable
 *     before the first event: the host resolves the initial `--model`
 *     (and builds the session's model scope) BEFORE session_start fires,
 *     so a session_start-only registration loses `--model
 *     github-copilot/auto` to "Model not found" at startup. The load
 *     registration carries NO apiKey (none exists yet — credential
 *     resolution stays lazy through the unchanged provider id's stored
 *     OAuth) and an `oauth` marker that satisfies the host's "apiKey or
 *     oauth required when defining models" validation without shadowing
 *     the built-in Copilot OAuth descriptor (the host consults its
 *     built-in provider registry first for login/refresh). The load
 *     default anchors openai-responses @ the account-specific host —
 *     the current Copilot GPT/MAI catalog family (mai-code-1.1-flash,
 *     gpt-5.4, …); the old openai-completions default is what sent
 *     mai-code-1.1-flash to /chat/completions (the reported 400);
 *   - session_start registration (register) re-anchors: it resolves the
 *     credential, probes the pool, maps pool ids to catalog endpoint
 *     metadata via ctx.models.list() (provider github-copilot, matching
 *     catalog model id, account-specific baseUrl), groups the pool by
 *     endpoint descriptor (API + normalized base URL), and re-registers
 *     the shell model for the chosen descriptor with the bearer — a
 *     wholesale replacement, so no stale load-phase entry survives.
 *     Guarded to run exactly once and single-flighted across concurrent
 *     session_start / first-turn callers;
 *   - credential_disabled re-arms via reset() so the next session_start
 *     re-resolves the credential and re-registers;
 *   - Claude anchor keeps the /v1 baseUrl — the host honors per-model
 *     baseUrl (bundle sOe uses `u.baseUrl ?? t`), and the Anthropic SDK
 *     appends /messages itself;
 *   - strict-tool markers go through provider `compat` only: the runtime's
 *     registerProvider passes `t.compat` into the model builder and
 *     ignores any top-level model-entry flag.
 */

import {
  OMP_AUTO_API,
} from "./omp-native-provider.ts";
import {
  capiBase,
  COPILOT_BASE_URL,
  COPILOT_HEADERS,
  DEFAULT_COPILOT_DESCRIPTOR,
  descriptorForId,
  endpointKey,
  isCopilotApi,
  type CapiClient,
} from "./capi-client.ts";
import { IntentRouter, type IntentRouterOptions } from "./intent-router.ts";
import type { LoggerLike } from "./types.ts";
import type {
  AutoSession,
  EndpointDescriptor,
  ExtensionAPI,
  ExtensionCtx,
  ProviderModelEntry,
  ProviderRegistration,
} from "./types.ts";
import { catalogModelEntries, loadPhaseOAuth, resolveProviderCredential, runtimeKind } from "./runtime-compat.ts";

/** Public id of the single injected model: github-copilot/auto. */
export const AUTO_MODEL_ID = "auto";
/** Provider id stays the builtin id so stored-OAuth lookups keep working. */
export const COPILOT_PROVIDER_ID = "github-copilot";

/** Copilot Chat request headers used by native model transports. */
export function copilotHeaders(): Record<string, string> {
  return { ...COPILOT_HEADERS };
}

/**
 * The single shell model for the given anchor descriptor. The descriptor
 * decides the wire API and base URL; routing then only ever picks models
 * inside that endpoint's session pool (within-endpoint constraint,
 * DESIGN §8).
 */
export function buildAutoModel(descriptor: EndpointDescriptor): ProviderModelEntry {
  switch (descriptor.api) {
    case "anthropic-messages":
      return {
        id: AUTO_MODEL_ID,
        name: "Auto (Copilot)",
        api: "anthropic-messages",
        baseUrl: `${COPILOT_BASE_URL}/v1`, // per-model baseUrl is honored by the host; Anthropic SDK appends /messages
        contextWindow: 200_000,
        maxTokens: 64_000,
        input: ["text", "image"],
        reasoning: true,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      };
    case "openai-completions":
      return {
        id: AUTO_MODEL_ID,
        name: "Auto (Copilot)",
        api: "openai-completions",
        baseUrl: descriptor.baseUrl,
        contextWindow: 400_000,
        maxTokens: 128_000,
        input: ["text", "image"],
        reasoning: true,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        compat: {
          strictResponsesPairing: true,
          supportsDeveloperRole: false,
          supportsImageDetailOriginal: false,
        },
      };
    case "openai-responses":
      return {
        id: AUTO_MODEL_ID,
        name: "Auto (Copilot)",
        api: "openai-responses",
        baseUrl: descriptor.baseUrl,
        contextWindow: 400_000,
        maxTokens: 128_000,
        input: ["text", "image"],
        reasoning: true,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        // Catalog responses models carry no compat overrides; the
        // responses transport needs none for copilot.
      };
  }
}

/** Endpoint metadata map from the host registry (catalog + registered).
 *  Only provider github-copilot entries with a supported api and a base
 *  URL are indexed, keyed by the catalog model id. */
export function catalogDescriptors(ctx: ExtensionCtx): Map<string, EndpointDescriptor> {
  const out = new Map<string, EndpointDescriptor>();
  for (const model of catalogModelEntries(ctx)) {
    if (typeof model.id !== "string" || model.id.length === 0) continue;
    if (model.provider !== undefined && model.provider !== COPILOT_PROVIDER_ID) continue;
    if (!isCopilotApi(model.api) || typeof model.baseUrl !== "string" || model.baseUrl.length === 0) {
      continue;
    }
    out.set(model.id, { api: model.api, baseUrl: model.baseUrl });
  }
  return out;
}

/**
 * Pick the anchor descriptor for the session pool: group pool ids by
 * endpoint (api + normalized base URL — catalog metadata first, heuristic
 * for ids the catalog has not seen yet, unknown ids dropped), prefer the
 * server selected_model's endpoint, then the largest group, then the
 * load-phase default. Never picks a cross-family id (the pool ids in one
 * group all share one endpoint).
 */
export function pickAnchorDescriptor(
  session: AutoSession | undefined,
  catalog: ReadonlyMap<string, EndpointDescriptor>,
): EndpointDescriptor {
  interface EndpointGroup {
    descriptor: EndpointDescriptor;
    models: string[];
  }
  const groups = new Map<string, EndpointGroup>();
  for (const id of session?.availableModels ?? []) {
    const descriptor = descriptorForId(id, catalog);
    if (!descriptor) continue;
    const key = endpointKey(descriptor);
    let group = groups.get(key);
    if (!group) {
      group = { descriptor, models: [] };
      groups.set(key, group);
    }
    group.models.push(id);
  }
  if (session?.selectedModelID) {
    for (const group of groups.values()) {
      if (group.models.includes(session.selectedModelID)) return group.descriptor;
    }
  }
  let largest: EndpointGroup | undefined;
  for (const group of groups.values()) {
    if (!largest || group.models.length > largest.models.length) largest = group;
  }
  return largest?.descriptor ?? DEFAULT_COPILOT_DESCRIPTOR;
}

interface RegistrarResult {
  registered: boolean;
  descriptor: EndpointDescriptor | undefined;
  seededSession: AutoSession | undefined;
  /** Session id the probe session was minted for — the token is
   *  conversation-scoped, so the seed is only valid for this session. */
  seededSessionId: string | undefined;
  bearer: string | undefined;
}

type LoadPhaseProviderOverrides = Partial<
  Pick<ProviderRegistration, "api" | "models" | "streamSimple" | "fetchDynamicModels">
>;

export class ProviderRegistrar {
  private done = false;
  private inflight?: Promise<RegistrarResult>;
  private lastDescriptor: EndpointDescriptor | undefined;
  private lastBearer: string | undefined;
  private lastSeededSessionId: string | undefined;
  /** Monotonically increasing generation counter.  Each reset() bumps
   *  it so stale in-flight doRegister() work detects it was superseded
   *  and drops its side effects (registerProvider, done, catalog). */
  private _gen = 0;
  /** Endpoint metadata map captured at registration — feeds the router's
   *  candidate filtering (unknown ids are never token-stamped). */
  private catalog = new Map<string, EndpointDescriptor>();

  constructor(
    private readonly client: CapiClient,
    private readonly logger: LoggerLike,
    private readonly probeTimeoutMs: number,
  ) {}

  /**
   * Load-phase registration (DESIGN §9.4, "时机"): the host resolves the
   * initial `--model` / session model scope BEFORE session_start fires, so
   * the shell model must exist the moment the extension factory runs.
   * Registers with the openai-responses default anchor (the
   * probe-failure default) and NO apiKey — credential resolution stays
   * lazy through the unchanged provider id's stored OAuth, and the
   * `oauth` marker satisfies the runtime's "apiKey or oauth required when
   * defining models" validation without shadowing the built-in Copilot
   * OAuth descriptor. register() re-anchors this entry on session_start
   * (wholesale replacement — no stale entries).
   */
  registerDefault(pi: ExtensionAPI, overrides: LoadPhaseProviderOverrides = {}): void {
    const config: ProviderRegistration = {
      baseUrl: COPILOT_BASE_URL,
      headers: copilotHeaders(),
      // OMP only: satisfies the host's "apiKey or oauth required when
      // defining models" validation. Omitted on Pi, whose registerProvider
      // would adapt a supplied `oauth` as a COMPLETE ExtensionOAuthConfig
      // (login/refreshToken/getApiKey) and shadow the built-in GitHub
      // Copilot OAuth with a broken partial config.
      oauth: loadPhaseOAuth(runtimeKind(pi)),
      models: [buildAutoModel(DEFAULT_COPILOT_DESCRIPTOR)],
      ...overrides,
    };
    try {
      pi.registerProvider(COPILOT_PROVIDER_ID, config);
    } catch (error) {
      // Registration must never break extension load; the session_start
      // re-registration still fires later.
      this.logger.log(`load-phase registration failed: ${String(error)}`);
    }
    this.logger.log(
      `load-phase registered github-copilot/${AUTO_MODEL_ID} (default anchor ${DEFAULT_COPILOT_DESCRIPTOR.api}@${DEFAULT_COPILOT_DESCRIPTOR.baseUrl}, credential deferred)`,
    );
  }

  /**
   * Re-arm after credential_disabled: the next session_start re-resolves
   * the credential and re-registers the shell model (DESIGN §9.4).
   */
  reset(): void {
    this.done = false;
    this.lastDescriptor = undefined;
    this.lastBearer = undefined;
    this.lastSeededSessionId = undefined;
    this._gen++;
    this.inflight = undefined;
    this.catalog = new Map();
  }

  /**
   * Discover the current Auto pool during OMP model resolution. OMP invokes
   * this callback before resolving a startup `--model`; no host catalog is
   * available at that phase, so only ids with a conservative endpoint
   * heuristic become selectable aliases.
   */
  async fetchLoadPhaseAliases(apiKey?: string): Promise<ProviderModelEntry[]> {
    if (!apiKey) return [];
    const session = await this.client.fetchAutoSession(COPILOT_BASE_URL, apiKey, this.probeTimeoutMs);
    if (!session) return [];

    const aliases: ProviderModelEntry[] = [];
    const emptyCatalog = new Map<string, EndpointDescriptor>();
    for (const realModelId of session.availableModels) {
      if (!realModelId || realModelId.startsWith("auto-")) continue;
      const descriptor = descriptorForId(realModelId, emptyCatalog);
      if (!descriptor) continue;
      const model = buildAutoModel(descriptor);
      aliases.push({
        ...model,
        id: `auto-${realModelId}`,
        name: `${realModelId} (auto)`,
        api: OMP_AUTO_API,
        baseUrl: COPILOT_BASE_URL,
      });
    }
    return aliases;
  }

  /**
   * Resolve the bearer credential, probe the pool, pick the anchor
   * endpoint from pool + catalog metadata, then re-register the shell
   * model (replaces the load-phase default). Idempotent and
   * single-flighted: session_start and the first before_provider_request
   * can race; both share one registration and observe the same result.
   */
  async register(pi: ExtensionAPI, ctx: ExtensionCtx): Promise<RegistrarResult> {
    if (this.done) {
      return {
        registered: false,
        descriptor: this.lastDescriptor,
        seededSession: undefined,
        seededSessionId: this.lastSeededSessionId,
        bearer: this.lastBearer,
      };
    }
    if (!this.inflight) {
      const gen = this._gen;
      this.inflight = this.doRegister(pi, ctx).finally(() => {
        // Only clear the inflight slot if no reset() has bumped the
        // generation since this registration started.  A stale
        // generation means this work was superseded — do not clobber
        // a newer inflight promise or leave the slot occupied.
        if (gen === this._gen) {
          this.inflight = undefined;
        }
      });
    }
    return await this.inflight;
  }

  private async doRegister(pi: ExtensionAPI, ctx: ExtensionCtx): Promise<RegistrarResult> {
    const gen = this._gen;
    const sessionId = ctx.sessionManager?.getSessionId?.();
    // Runtime-agnostic credential resolution: getApiKeyForProvider on both
    // hosts, Pi's getProviderAuth fallback when the primary is absent.
    // Never logs the credential.
    const bearer = await resolveProviderCredential(ctx.modelRegistry, COPILOT_PROVIDER_ID, sessionId);
    if (!bearer) {
      this.logger.log("no github-copilot credential resolvable; extension idle until credential re-enabled");
      return { registered: false, descriptor: undefined, seededSession: undefined, seededSessionId: undefined, bearer: undefined };
    }

    // The registry's catalog may still be mid-load at session_start (the
    // static bundle serves generic-host entries until the cached catalog
    // lands). Trigger + await the host's own background refresh — the
    // same path its get_available_models RPC uses — so pool ids map to
    // the account's current endpoints (api + account-specific baseUrl).
    await ctx.modelRegistry?.refreshInBackground?.();
    await ctx.modelRegistry?.awaitBackgroundRefresh?.();

    // Catalog metadata (api + account-specific baseUrl per pool id) from
    // the host registry; the probe (2s cap) supplies the session pool.
    const catalog = catalogDescriptors(ctx);
    const seededSession = await this.client.fetchAutoSession(COPILOT_BASE_URL, bearer, this.probeTimeoutMs);
    const descriptor = pickAnchorDescriptor(seededSession, catalog);
    const poolMapped = (seededSession?.availableModels ?? [])
      .map((id) => {
        const endpoint = descriptorForId(id, catalog);
        return endpoint ? `${id}=${endpoint.api}@${capiBase(endpoint.baseUrl)}` : `${id}=unknown`;
      })
      .join(", ");
    this.logger.log(
      `anchor endpoint=${descriptor.api}@${capiBase(descriptor.baseUrl)} (pool=[${poolMapped}], catalog=${catalog.size}, probe=${seededSession ? "ok" : "failed"})`,
    );

    // A reset() during the async credential/probe work bumps _gen — the
    // registration was superseded.  Drop all side effects so the old
    // in-flight work never registers a provider, restores stale
    // done/catalog state, or clobbers a newer generation's slot.
    if (gen !== this._gen) {
      this.logger.log("registration superseded by reset; dropping stale result");
      return { registered: false, descriptor: undefined, seededSession: undefined, seededSessionId: undefined, bearer: undefined };
    }

    pi.registerProvider(COPILOT_PROVIDER_ID, {
      baseUrl: COPILOT_BASE_URL,
      apiKey: bearer,
      headers: copilotHeaders(),
      // Strict-tool control rides provider-level `compat`: the runtime's
      // registerProvider forwards `t.compat` into the model builder
      // (sOe(..., t.compat, ..., model)) and ignores model-entry flags.
      // Copilot's Anthropic proxy rejects strict schemas (#2558); the
      // other anchors keep their per-model compat flags inside
      // buildAutoModel.
      compat: descriptor.api === "anthropic-messages" ? { disableStrictTools: true } : undefined,
      models: [buildAutoModel(descriptor)],
    });

    this.done = true;
    this.lastDescriptor = descriptor;
    this.lastBearer = bearer;
    this.lastSeededSessionId = sessionId;
    this.catalog = catalog;
    return { registered: true, descriptor, seededSession, seededSessionId: sessionId, bearer };
  }
  /** Build the intent router bound to the registered anchor endpoint. */
  routerFor(descriptor: EndpointDescriptor, options: IntentRouterOptions = {}): IntentRouter {
    return new IntentRouter(this.client, this.logger, descriptor, options, this.catalog);
  }
}
