/**
 * copilot-auto — extension orchestrator.
 *
 * The orchestrator captures prompts, resolves the session/intent Auto route
 * and selects a host backend:
 *
 *   native provider — session/pool routing, request-local session headers,
 *                     and the host's native transport;
 *   fallback hook  — before_provider_request + bounded FetchPatch fallback.
 *
 * Native routing is sticky per conversation until compaction or expiry.
 * Session aliases use `auto-<real-model-id>` and are generated only from the
 * latest successful Auto pool. All lifecycle hooks clear session-scoped state;
 * credentials and session tokens are never logged.
 */

import {
  capiBase,
  CapiClient,
  COPILOT_BASE_URL,
  descriptorForId,
  isCopilotApi,
} from "./capi-client.ts";
import { ConvStateStore } from "./conv-state-store.ts";
import { FetchPatch, type TokenProvider } from "./fetch-patch.ts";
import { PendingTokenQueue } from "./pending-token-queue.ts";
import { IntentRouter, reasoningBucketFor } from "./intent-router.ts";
import {
  AUTO_MODEL_ID,
  COPILOT_PROVIDER_ID,
  ProviderRegistrar,
  catalogDescriptors,
  copilotHeaders,
} from "./provider-registrar.ts";
import { Logger } from "./logger.ts";
import {
  buildOmpProviderConfig,
  type LazyStream as OmpLazyStream,
  type NativeStreamSimple as OmpNativeStreamSimple,
  type OmpModel,
} from "./omp-native-provider.ts";
import { wrapPiProvider, type Model as PiModel, type PiProvider, type RoutePlan as PiRoutePlan } from "./pi-native-provider.ts";
import {
  catalogModelEntries,
  resolveLazyStreamFactory,
  resolveNativeStreamSimpleFactory,
  runtimeKind,
} from "./runtime-compat.ts";
import type {
  AutoSession,
  ConvState,
  CopilotAutoOptions,
  CopilotCatalogModel,
  EndpointDescriptor,
  ExtensionAPI,
  ExtensionCtx,
  LoggerLike,
  ProviderModelEntry,
  ProviderRegistration,
  ReasoningBucket,
  WirePayload,
} from "./types.ts";

const DEFAULT_PROBE_TIMEOUT_MS = 2_000;

/** Payload shape as delivered by emitBeforeProviderRequest. */
interface BeforeProviderRequestEvent {
  payload?: WirePayload;
}

interface LoadPhaseAuthStorage {
  getApiKey?(providerId: string): Promise<string | undefined> | string | undefined;
  peekApiKey?(providerId: string): Promise<string | undefined> | string | undefined;
  close?(): void | Promise<void>;
}

interface LoadPhaseHostPackage {
  discoverAuthStorage?: () => Promise<LoadPhaseAuthStorage>;
}

class RouteInvalidatedError extends Error {
  constructor() {
    super("Copilot Auto route invalidated by lifecycle boundary");
    this.name = "RouteInvalidatedError";
  }
}

export class CopilotAuto {
  private readonly logger: LoggerLike;
  private readonly client: CapiClient;
  private readonly store: ConvStateStore;
  private readonly registrar: ProviderRegistrar;
  private readonly fetchPatch: FetchPatch;
  private readonly options: CopilotAutoOptions;

  private descriptor?: EndpointDescriptor;
  private router?: IntentRouter;
  private bearer?: string;
  /** Native provider mode is preferred; false means the fallback hook path. */
  private nativeMode = false;
  private nativeCtx?: ExtensionCtx;
  private nativePool: string[] = [];
  private nativeCatalog = new Map<string, EndpointDescriptor>();
  /** Catalog-level probe result — only seeds the session it was minted for
   *  (Copilot-Session-Token is conversation-scoped). */
  private seededSession?: AutoSession;
  private seededSessionId?: string;

  /** Monotonic teardown generation. Async work captured before shutdown or
   * credential disable must not re-enable a dead session when it settles. */
  private lifecycleEpoch = 0;
  /** Pending Copilot-Session-Token per wire model id (FIFO), queued right
   *  before before_provider_request returns and consumed by the fetch
   *  patch at send-time. Entries are session-tagged so shutdown/compaction
   *  drop exactly the right tokens. Tokens are conversation-scoped; never
   *  logged. */
  private readonly pendingTokens = new PendingTokenQueue();

  constructor(
    private readonly pi: ExtensionAPI,
    options: CopilotAutoOptions = {},
  ) {
    this.options = options;
    const fileLogger = new Logger();
    this.logger = {
      log: (msg) => {
        fileLogger.log(msg);
        try {
          pi.logger?.info(msg);
        } catch {}
      },
    };
    this.client = new CapiClient(this.logger, { apiVersion: options.apiVersion, sessionOpenTimeoutMs: options.sessionOpenTimeoutMs });
    this.store = new ConvStateStore(this.client, this.logger, {
      refreshSkewMs: options.refreshSkewMs,
      sessionOpenTimeoutMs: options.sessionOpenTimeoutMs,
    });
    this.registrar = new ProviderRegistrar(
      this.client,
      this.logger,
      options.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS,
    );

    const tokenProvider: TokenProvider = {
      takeTokenForWireModel: (wireModel) => this.pendingTokens.take(wireModel),
    };
    this.fetchPatch = new FetchPatch(tokenProvider, (msg) => this.logger.log(msg));
  }
  /**
   * OMP resolves `--model` before session_start. Register a load-phase
   * custom stream for `auto` and a dynamic pool fetcher so startup aliases
   * resolve to the same native route used after session_start.
   */
  private async loadPhaseProviderOverrides(): Promise<Partial<
    Pick<ProviderRegistration, "api" | "models" | "streamSimple" | "fetchDynamicModels">
  >> {
    if (runtimeKind(this.pi) !== "omp") return {};
    const nativeStreamSimple = this.pi.streamSimple;
    const lazyStream = this.pi.lazyStream;
    if (typeof nativeStreamSimple !== "function" || typeof lazyStream !== "function") return {};

    const config = buildOmpProviderConfig({
      catalog: [],
      getCatalog: () => this.nativeCtx ? this.nativeCatalogEntries(this.nativeCtx) : [],
      visiblePool: [],
      getVisiblePool: () => this.nativePool,
      routeResolver: async (managedId, context, options) =>
        await this.resolveNativeRoute(managedId, context, options),
      nativeStreamSimple: nativeStreamSimple as OmpNativeStreamSimple,
      lazyStream: lazyStream as OmpLazyStream,
    });
    const aliases = await this.fetchLoadPhaseAliases();
    return {
      api: config.api,
      models: [...(config.models as unknown as ProviderModelEntry[]), ...aliases],
      streamSimple: config.streamSimple as ProviderRegistration["streamSimple"],
      fetchDynamicModels: (apiKey) => this.fetchLoadPhaseAliases(apiKey),
    };
  }

  private async fetchLoadPhaseAliases(apiKey?: string): Promise<ProviderModelEntry[]> {
    const resolvedApiKey = apiKey ?? await this.resolveLoadPhaseApiKey();
    return this.registrar.fetchLoadPhaseAliases(resolvedApiKey);
  }

  private async resolveLoadPhaseApiKey(): Promise<string | undefined> {
    const hostPackage = this.pi.pi as LoadPhaseHostPackage | undefined;
    const discoverAuthStorage = hostPackage?.discoverAuthStorage;
    if (typeof discoverAuthStorage !== "function") return undefined;

    try {
      const storage = await discoverAuthStorage();
      try {
        const resolveApiKey = storage.getApiKey ?? storage.peekApiKey;
        if (typeof resolveApiKey !== "function") return undefined;
        return await resolveApiKey.call(storage, COPILOT_PROVIDER_ID);
      } finally {
        await storage.close?.();
      }
    } catch {
      return undefined;
    }
  }

  register(): void {
    this.registrar.registerDefault(this.pi);
    this.registerHooks();
  }

  async registerWithDiscovery(): Promise<void> {
    const overrides = await this.loadPhaseProviderOverrides();
    this.registrar.registerDefault(this.pi, overrides);
    this.registerHooks();
  }

  private registerHooks(): void {
    // Hook registration at load; the fetch patch is installed per session
    // so it nests over whatever fetch OMP core has by session start.
    this.pi.on("session_start", async (_event, ctx) => {
      const lifecycleEpoch = this.lifecycleEpoch;
      const native = await this.ensureNativeRegistered(ctx, lifecycleEpoch);
      if (!this.isLifecycleCurrent(lifecycleEpoch)) return;
      if (!native) {
        this.fetchPatch.install();
        await this.ensureRegistered(ctx, lifecycleEpoch);
        if (!this.isLifecycleCurrent(lifecycleEpoch)) return;
      }
      const status = this.nativeMode
        ? "ready (native)"
        : this.descriptor
          ? `ready (${this.descriptor.api})`
          : "idle";
      ctx.ui.setStatus("copilot-auto", status);
    });

    this.pi.on("input", async (event, ctx) => {
      const raw = event as { text?: unknown; images?: unknown };
      this.capturePrompt(raw.text, raw.images, ctx);
    });

    this.pi.on("before_agent_start", async (event, ctx) => {
      const raw = event as { prompt?: unknown; images?: unknown };
      this.capturePrompt(raw.prompt, raw.images, ctx);
    });

    this.pi.on("before_provider_request", async (event, ctx) => {
      if (this.nativeMode) return undefined;
      return await this.routeRequest(event as BeforeProviderRequestEvent, ctx);
    });

    this.pi.on("session_before_compact", async (event) => {
      const raw = event as { sessionId?: unknown };
      const sessionId = typeof raw.sessionId === "string" ? raw.sessionId : undefined;
      this.store.markNeedsReEval(sessionId);
      if (sessionId) {
        this.pendingTokens.clearForSession(sessionId);
      } else {
        this.pendingTokens.clear();
      }
      this.fetchPatch.clearLeases();
    });

    this.pi.on("session_shutdown", async () => {
      this.invalidateLifecycleState();
    });

    this.pi.on("credential_disabled", async () => {
      this.invalidateLifecycleState();
      this.logger.log("credential disabled — re-registering on next session_start");
    });

    this.pi.registerCommand("copilot-auto", {
      description: "Show copilot-auto routing status",
      handler: async (_args, ctx) => {
        const detail = this.descriptor
          ? `endpoint=${this.descriptor.api}@${this.descriptor.baseUrl}, bearer=${this.bearer ? "ok" : "missing"}`
          : "not registered yet";
        ctx.ui.notify?.(`copilot-auto: ${detail}`, "info");
      },
    });

    this.logger.log("copilot-auto registered");
  }

  // ── prompt capture ────────────────────────────────────────────────

  /** Capture the turn's prompt text (and image/reference count) into the
   *  current session's ConvState so intent routing sees the prompt that
   *  triggered the turn. Shared by the interactive `input` hook and the
   *  RPC `before_agent_start` hook. A missing or empty prompt NEVER
   *  overwrites a captured one, and referenceCount is only written when
   *  an images list is actually present (an empty list resets it to 0). */
  private capturePrompt(text: unknown, images: unknown, ctx: ExtensionCtx): void {
    if (typeof text !== "string") return;
    const trimmed = text.trim();
    if (trimmed.length === 0) return;
    const sessionId = ctx.sessionManager?.getSessionId?.() ?? "unknown-session";
    const conv = this.store.get(sessionId, AUTO_MODEL_ID);
    conv.lastPrompt = trimmed;
    if (Array.isArray(images)) {
      conv.referenceCount = images.length;
      conv.hasImage = images.length > 0;
    }
  }

  /** Tear down every credential- and session-bound object synchronously.
   * Late async work observes the epoch mismatch and must discard itself. */
  private invalidateLifecycleState(): void {
    this.lifecycleEpoch += 1;
    this.registrar.reset();
    this.nativeMode = false;
    this.nativeCtx = undefined;
    this.nativePool = [];
    this.nativeCatalog.clear();
    this.bearer = undefined;
    this.descriptor = undefined;
    this.router = undefined;
    this.seededSession = undefined;
    this.seededSessionId = undefined;
    this.fetchPatch.restore();
    this.pendingTokens.clear();
    this.store.clear();
  }

  private isLifecycleCurrent(epoch: number): boolean {
    return epoch === this.lifecycleEpoch;
  }


  // ── registration ──────────────────────────────────────────────────

  private async ensureRegistered(
    ctx: ExtensionCtx,
    lifecycleEpoch = this.lifecycleEpoch,
  ): Promise<void> {
    if (!this.isLifecycleCurrent(lifecycleEpoch) || !ctx.modelRegistry) {
      if (this.isLifecycleCurrent(lifecycleEpoch)) {
        this.logger.log("no modelRegistry in context; registration skipped");
      }
      return;
    }
    try {
      const result = await this.registrar.register(this.pi, ctx);
      if (!this.isLifecycleCurrent(lifecycleEpoch)) return;
      if (result.registered && result.descriptor) {
        this.descriptor = result.descriptor;
        this.router = this.registrar.routerFor(result.descriptor, { intentTimeoutMs: this.options.intentTimeoutMs });
        this.seededSession = result.seededSession;
        this.seededSessionId = result.seededSessionId;
        this.bearer = result.bearer;
      }
    } catch (error) {
      if (this.isLifecycleCurrent(lifecycleEpoch)) {
        this.logger.log(`registration failed: ${String(error)}`);
      }
    }
  }

  // ── per-turn routing ──────────────────────────────────────────────

  private async routeRequest(
    event: BeforeProviderRequestEvent,
    ctx: ExtensionCtx,
  ): Promise<WirePayload | undefined> {
    const payload = event.payload;
    if (!payload || payload.model !== AUTO_MODEL_ID) return undefined;

    const lifecycleEpoch = this.lifecycleEpoch;
    try {
      // Hard guard against the session_start race: registration normally
      // runs there, but the anchor probe takes up to probeTimeoutMs and
      // the first before_provider_request can fire before it settles.
      await this.ensureRegistered(ctx, lifecycleEpoch);
      if (!this.isLifecycleCurrent(lifecycleEpoch) || !this.router || !this.descriptor) {
        if (this.isLifecycleCurrent(lifecycleEpoch)) {
          this.logger.log("routing skipped: auto model not registered (no credential or registration failed)");
        }
        return undefined;
      }
      const router = this.router;
      const sessionId = ctx.sessionManager?.getSessionId?.() ?? "unknown-session";
      const conv: ConvState = this.store.get(sessionId, AUTO_MODEL_ID);
      const routeGeneration = this.store.getRouteGeneration(conv);
      const isTurnZero = conv.turn === 0;
      const wasCompactionReroute = conv.needsReEval === true;

      // The probe session's token is conversation-scoped: seed only the
      // session it was minted for; every other session opens its own.
      const seed = this.seededSessionId === sessionId ? this.seededSession : undefined;
      await this.store.ensureSession(sessionId, AUTO_MODEL_ID, capiBase(COPILOT_BASE_URL), this.bearer, seed);
      const verdict = await router.decideTurn({
        conv,
        sessionId,
        baseURL: COPILOT_BASE_URL,
        bearer: this.bearer,
        prompt: conv.lastPrompt,
      });
      if (
        !this.isLifecycleCurrent(lifecycleEpoch) ||
        !this.store.isRouteCurrent(sessionId, AUTO_MODEL_ID, conv, routeGeneration)
      ) {
        this.logger.log("routing discarded after lifecycle boundary");
        return undefined;
      }

      payload.model = verdict.decided;
      router.applyReasoningBoost(payload, verdict.decided, verdict.label, verdict.reasoningBucket);
      this.store.commitRouting(
        conv,
        verdict.decided,
        verdict.label,
        verdict.omitSessionToken,
        verdict.confidence,
        verdict.reasoningBucket,
      );

      if (!conv.omitSessionToken) {
        const token = conv.session?.sessionToken;
        if (token) this.pendingTokens.queue(verdict.decided, sessionId, token);
      }

      const conf = verdict.confidence !== undefined ? `, conf=${verdict.confidence}` : "";
      this.logger.log(
        `turn ${conv.turn} auto -> ${verdict.decided} (${verdict.label ?? "no_label"}${conf}, source=${verdict.source})`,
      );

      if (this.options.statusBar !== false) {
        ctx.ui.setStatus("copilot-auto", `→ ${verdict.decided}`);
      }
      if (verdict.source === "intent" && (isTurnZero || wasCompactionReroute)) {
        ctx.ui.notify?.(`Auto → ${verdict.decided} · ${verdict.label ?? "no label"}`, "info");
      }
      return payload;
    } catch (error) {
      if (this.isLifecycleCurrent(lifecycleEpoch)) {
        this.logger.log(`routing error, passing payload through: ${String(error)}`);
      }
      return undefined;
    }
  }
  // ── native Provider registration ─────────────────────────────────

  private async ensureNativeRegistered(
    ctx: ExtensionCtx,
    lifecycleEpoch = this.lifecycleEpoch,
  ): Promise<boolean> {
    if (!this.isLifecycleCurrent(lifecycleEpoch) || !ctx.modelRegistry) return false;

    const kind = runtimeKind(this.pi);
    const rawBase = kind === "pi"
      ? ctx.modelRegistry.getProvider?.(COPILOT_PROVIDER_ID)
      : undefined;
    const base = this.asNativeProvider(rawBase);
    const ompBridge = kind === "omp"
      ? await resolveNativeStreamSimpleFactory(this.pi)
      : undefined;
    const lazyStream = await resolveLazyStreamFactory(this.pi, kind);
    if (!this.isLifecycleCurrent(lifecycleEpoch)) return false;

    if (kind === "pi" && (!base || !lazyStream)) {
      this.logger.log("native Pi provider or lazy stream unavailable; using fallback hook path");
      return false;
    }
    if (kind === "omp" && (!ompBridge || !lazyStream)) {
      this.logger.log("OMP native stream bridge unavailable; using FetchPatch fallback");
      return false;
    }
    if (!lazyStream) return false;
    // Capture a catalog snapshot before any registration can replace the
    // provider's visible model slice (Pi/OMP both support replacement).
    const catalogBeforeRegistration = catalogModelEntries(ctx);
    const descriptorsBeforeRegistration = catalogDescriptors(ctx);


    try {
      const result = await this.registrar.register(this.pi, ctx);
      if (!this.isLifecycleCurrent(lifecycleEpoch)) return false;
      if (!result.registered || !result.bearer) return false;

      this.descriptor = result.descriptor;
      this.router = result.descriptor
        ? this.registrar.routerFor(result.descriptor, { intentTimeoutMs: this.options.intentTimeoutMs })
        : undefined;
      this.seededSession = result.seededSession;
      this.seededSessionId = result.seededSessionId;
      this.bearer = result.bearer;
      this.nativeCtx = ctx;
      this.nativeCatalog = new Map(descriptorsBeforeRegistration);
      for (const [modelId, descriptor] of catalogDescriptors(ctx)) {
        this.nativeCatalog.set(modelId, descriptor);
      }
      this.nativePool = [...(result.seededSession?.availableModels ?? [])];
      for (const modelId of this.nativePool) {
        const descriptor = descriptorForId(modelId, this.nativeCatalog);
        if (descriptor) this.nativeCatalog.set(modelId, descriptor);
      }
      const catalogEntries = this.nativeCatalogEntries(ctx, catalogBeforeRegistration);

      if (kind === "pi" && base) {
        const baseModels = base.getModels();
        const template = baseModels.find((model) => !this.isAutoId(model.id)) ?? baseModels[0];
        if (!template) return false;
        const wrapper = wrapPiProvider(base, {
          template,
          catalog: this.nativePiModels(catalogEntries, template),
          visiblePool: this.nativePool,
          getVisiblePool: () => this.nativePool,
          routeResolver: async (managedId, context, options) =>
            await this.resolveNativeRoute(managedId, context, options, lifecycleEpoch),
          nativeStreamSimple: (model, context, options) =>
            base.streamSimple(model, context, options),
          lazyStream,
          headers: copilotHeaders(),
        });
        const registerNative = (this.pi as unknown as {
          registerProvider(provider: unknown): void;
        }).registerProvider;
        registerNative.call(this.pi, wrapper);
        this.nativeMode = true;
        this.logger.log(`native Pi provider registered (pool=${this.nativePool.length})`);
        return true;
      }

      if (kind === "omp" && ompBridge) {
        const config = buildOmpProviderConfig({
          catalog: catalogEntries as OmpModel[],
          visiblePool: this.nativePool,
          getVisiblePool: () => this.nativePool,
          routeResolver: async (managedId, context, options) =>
            await this.resolveNativeRoute(managedId, context, options, lifecycleEpoch),
          nativeStreamSimple: ompBridge,
          lazyStream,
        });
        const registerConfig = (this.pi as unknown as {
          registerProvider(providerId: string, config: unknown): void;
        }).registerProvider;
        registerConfig.call(this.pi, COPILOT_PROVIDER_ID, {
          baseUrl: COPILOT_BASE_URL,
          apiKey: result.bearer,
          headers: copilotHeaders(),
          api: config.api,
          models: config.models as unknown as ProviderModelEntry[],
          streamSimple: config.streamSimple,
          fetchDynamicModels: config.fetchDynamicModels,
        });
        try {
          if (ctx.modelRegistry.refreshRuntimeProviders) {
            await ctx.modelRegistry.refreshRuntimeProviders("online");
          } else {
            ctx.modelRegistry.refreshInBackground?.("online");
            await ctx.modelRegistry.awaitBackgroundRefresh?.();
          }
        } catch (error) {
          this.logger.log(`native OMP model refresh failed: ${String(error)}`);
        }
        if (!this.isLifecycleCurrent(lifecycleEpoch)) return false;
        this.nativeMode = true;
        this.logger.log(`native OMP provider registered (pool=${this.nativePool.length})`);
        return true;
      }
    } catch (error) {
      this.logger.log(`native provider registration failed: ${String(error)}`);
    }
    return false;
  }

  private nativeCatalogEntries(
    ctx: ExtensionCtx,
    beforeRegistration: readonly CopilotCatalogModel[] = [],
  ): CopilotCatalogModel[] {
    const byId = new Map<string, CopilotCatalogModel>();
    for (const model of [...beforeRegistration, ...catalogModelEntries(ctx)]) {
      if (typeof model.id !== "string" || model.id.length === 0 || this.isAutoId(model.id)) continue;
      if (model.provider !== undefined && model.provider !== COPILOT_PROVIDER_ID) continue;
      if (!isCopilotApi(model.api) || typeof model.baseUrl !== "string" || model.baseUrl.length === 0) continue;
      byId.set(model.id, model);
    }
    for (const modelId of this.nativePool) {
      if (byId.has(modelId)) continue;
      const descriptor = descriptorForId(modelId, this.nativeCatalog);
      if (!descriptor) continue;
      byId.set(modelId, {
        provider: COPILOT_PROVIDER_ID,
        id: modelId,
        name: modelId,
        api: descriptor.api,
        baseUrl: descriptor.baseUrl,
      });
    }
    return [...byId.values()];
  }

  private nativePiModels(entries: readonly CopilotCatalogModel[], template: PiModel): PiModel[] {
    return entries.map((entry) => ({
      ...template,
      ...entry,
      id: entry.id,
      name: entry.name ?? entry.id,
      provider: entry.provider ?? template.provider ?? COPILOT_PROVIDER_ID,
      api: entry.api ?? template.api,
      baseUrl: entry.baseUrl ?? template.baseUrl ?? COPILOT_BASE_URL,
    }));
  }

  private asNativeProvider(value: unknown): PiProvider | undefined {
    if (!value || typeof value !== "object") return undefined;
    const candidate = value as Partial<PiProvider>;
    if (
      typeof candidate.getModels !== "function" ||
      typeof candidate.stream !== "function" ||
      typeof candidate.streamSimple !== "function"
    ) {
      return undefined;
    }
    return candidate as PiProvider;
  }

  private isAutoId(id: string): boolean {
    return id === AUTO_MODEL_ID || id.startsWith("auto-");
  }

  // ── native route resolution ───────────────────────────────────────

  private async resolveNativeRoute(
    managedModelId: string,
    _context: unknown,
    options?: unknown,
    lifecycleEpoch = this.lifecycleEpoch,
  ): Promise<PiRoutePlan> {
    if (!this.isLifecycleCurrent(lifecycleEpoch)) throw new RouteInvalidatedError();
    const sessionId = this.nativeSessionId(options);
    const targetId = managedModelId.startsWith("auto-")
      ? managedModelId.slice("auto-".length)
      : undefined;
    if (targetId) {
      return await this.resolveForcedNativeRoute(
        managedModelId,
        targetId,
        sessionId,
        options,
        lifecycleEpoch,
      );
    }

    return await this.resolveSessionIntentRoute(managedModelId, sessionId, options, lifecycleEpoch);
  }

  private async resolveForcedNativeRoute(
    managedModelId: string,
    targetId: string,
    sessionId: string,
    options: unknown,
    lifecycleEpoch: number,
  ): Promise<PiRoutePlan> {
    const conv = this.store.get(sessionId, managedModelId);
    const routeGeneration = this.store.getRouteGeneration(conv);
    const seed = this.seededSessionId === sessionId ? this.seededSession : undefined;
    const session = await this.store.ensureSession(
      sessionId,
      managedModelId,
      capiBase(COPILOT_BASE_URL),
      this.bearer,
      seed,
      {
        signal: this.nativeSignal(options),
        timeoutMs: this.options.sessionOpenTimeoutMs,
      },
    );
    this.assertRouteCurrent(sessionId, managedModelId, conv, routeGeneration, lifecycleEpoch);
    if (session) this.nativePool = [...session.availableModels];
    if (!session || !session.availableModels.includes(targetId)) {
      throw new Error(`Auto alias "${managedModelId}" is not in the current session pool`);
    }
    const descriptor = descriptorForId(targetId, this.nativeCatalog);
    if (!descriptor) throw new Error(`Auto alias "${managedModelId}" has no known native endpoint`);

    this.commitNativeRoute(conv, targetId, undefined, undefined, false);
    return {
      realModelId: targetId,
      api: descriptor.api,
      baseUrl: descriptor.baseUrl,
      sessionToken: session.sessionToken,
      interactionId: session.interactionId,
      source: "forced",
    };
  }

  private async resolveSessionIntentRoute(
    managedModelId: string,
    sessionId: string,
    options: unknown,
    lifecycleEpoch: number,
  ): Promise<PiRoutePlan> {
    const conv = this.store.get(sessionId, managedModelId);
    const routeGeneration = this.store.getRouteGeneration(conv);
    const seed = this.seededSessionId === sessionId ? this.seededSession : undefined;
    const session = await this.store.ensureSession(
      sessionId,
      managedModelId,
      capiBase(COPILOT_BASE_URL),
      this.bearer,
      seed,
      {
        signal: this.nativeSignal(options),
        timeoutMs: this.options.sessionOpenTimeoutMs,
      },
    );
    this.assertRouteCurrent(sessionId, managedModelId, conv, routeGeneration, lifecycleEpoch);
    if (!session) throw new Error("Auto session could not be opened");
    this.nativePool = [...session.availableModels];

    if (conv.routedModelID && !conv.needsReEval) {
      const descriptor = descriptorForId(conv.routedModelID, this.nativeCatalog);
      if (descriptor) {
        conv.turn += 1;
        return {
          realModelId: conv.routedModelID,
          api: descriptor.api,
          baseUrl: descriptor.baseUrl,
          sessionToken: session.availableModels.includes(conv.routedModelID) ? session.sessionToken : undefined,
          interactionId: session.interactionId,
          reasoningBucket: conv.routedReasoningBucket,
          omitSessionToken: !session.availableModels.includes(conv.routedModelID),
          source: "sticky",
        };
      }
    }

    const prompt = this.promptForConversation(sessionId, managedModelId);
    const decision = prompt && this.bearer
      ? await this.client.getRouterDecision(
          capiBase(COPILOT_BASE_URL),
          this.bearer,
          session.sessionToken,
          prompt,
          session.availableModels,
          {
            session_id: sessionId,
            turn_number: conv.turn + 1,
            previous_model: conv.previousModel,
            reference_count: conv.referenceCount,
            prompt_char_count: prompt.length,
            has_image: conv.hasImage,
          },
          this.options.intentTimeoutMs,
          session.interactionId,
        )
      : undefined;
    const reasoningBucket = reasoningBucketFor(decision);
    const label = reasoningBucket ? "needs_reasoning" : decision?.predicted_label;
    const candidates = [
      decision?.selected_model,
      decision?.chosen_model,
      ...(decision?.candidate_models ?? []),
      session.selectedModelID,
      ...session.availableModels,
    ];
    const decided = candidates.find(
      (id): id is string =>
        typeof id === "string" &&
        session.availableModels.includes(id) &&
        descriptorForId(id, this.nativeCatalog) !== undefined,
    );
    if (!decided) throw new Error("Auto session has no routable model");

    const descriptor = descriptorForId(decided, this.nativeCatalog)!;
    this.commitNativeRoute(
      conv,
      decided,
      label,
      decision?.confidence,
      false,
      reasoningBucket,
    );
    return {
      realModelId: decided,
      api: descriptor.api,
      baseUrl: descriptor.baseUrl,
      sessionToken: session.sessionToken,
      interactionId: session.interactionId,
      reasoningBucket,
      source: decision ? "intent" : "fallback",
    };
  }

  private assertRouteCurrent(
    sessionId: string,
    modelId: string,
    conv: ConvState,
    routeGeneration: number,
    lifecycleEpoch: number,
  ): void {
    if (
      !this.isLifecycleCurrent(lifecycleEpoch) ||
      !this.store.isRouteCurrent(sessionId, modelId, conv, routeGeneration)
    ) {
      throw new RouteInvalidatedError();
    }
  }

  private commitNativeRoute(
    conv: ConvState,
    modelId: string,
    label: ConvState["routedLabel"],
    confidence: number | undefined,
    omitSessionToken: boolean,
    reasoningBucket?: ReasoningBucket,
  ): void {
    conv.routedModelID = modelId;
    conv.routedLabel = label;
    conv.routedReasoningBucket = reasoningBucket;
    conv.routedConfidence = confidence;
    conv.omitSessionToken = omitSessionToken;
    conv.previousModel = modelId;
    conv.needsReEval = false;
    conv.turn += 1;
  }

  private nativeSessionId(options?: unknown): string {
    if (options && typeof options === "object") {
      const sessionId = (options as { sessionId?: unknown }).sessionId;
      if (typeof sessionId === "string" && sessionId.length > 0) return sessionId;
    }
    return this.nativeCtx?.sessionManager?.getSessionId?.() ?? "unknown-session";
  }

  private nativeSignal(options?: unknown): AbortSignal | undefined {
    if (!options || typeof options !== "object") return undefined;
    const signal = (options as { signal?: unknown }).signal;
    if (
      signal &&
      typeof signal === "object" &&
      "aborted" in signal &&
      typeof (signal as { addEventListener?: unknown }).addEventListener === "function"
    ) {
      return signal as AbortSignal;
    }
    return undefined;
  }

  private promptForConversation(sessionId: string, modelId: string): string | undefined {
    return this.store.get(sessionId, modelId).lastPrompt
      ?? this.store.get(sessionId, AUTO_MODEL_ID).lastPrompt;
  }
}