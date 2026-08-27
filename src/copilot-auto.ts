/**
 * copilot-auto — extension orchestrator.
 *
 * Thin by design (smart-approve convention): constructs the collaborators
 * and routes the interception surfaces through them:
 *
 *   input / before_agent_start — capture the turn's prompt text + image
 *                       count into ConvState (interactive editor vs RPC
 *                       AgentSession.prompt, DESIGN §3)
 *   before_provider_request — per-turn routing: ensureSession → intent
 *                             router → payload.model override + boost
 *   before_provider_request — per-turn routing: ensureSession → intent
 *                             router → payload.model override + boost
 *   FetchPatch        — stamps Copilot-Session-Token on outgoing chat POSTs
 *   PendingTokenQueue — FIFO per-wire-model token queue, session-tagged
 *                       so shutdown/compaction drop exactly the right tokens
 *
 * Lifecycle: the extension FACTORY registers the shell model immediately
 * (load phase — the host resolves the initial `--model` and the session
 * model scope before session_start fires, so a session_start-only
 * registration would fail with "Model not found"); session_start installs
 * the fetch patch over the host's then-current wrapper and RE-ANCHORS the
 * shell model (credential + pool probe → wholesale replacement);
 * session_shutdown restores the patch and clears the pending token queue
 * so the next session recaptures the host's current fetch and no token
 * leaks across sessions; session_before_compact drops the compacted
 * conversation's queued tokens/leases so pre-compaction tokens never
 * stamp a post-compaction request.
 *
 * Logging goes to ~/.omp/logs/copilot-auto.log; every routing turn is
 * recorded with its wire model id, label, confidence and source (§9.5).
 * Session tokens and bearer credentials are NEVER logged.
 */

import { capiBase, CapiClient, COPILOT_BASE_URL } from "./capi-client.ts";
import { ConvStateStore } from "./conv-state-store.ts";
import { FetchPatch, type TokenProvider } from "./fetch-patch.ts";
import { PendingTokenQueue } from "./pending-token-queue.ts";
import { IntentRouter } from "./intent-router.ts";
import { AUTO_MODEL_ID, ProviderRegistrar } from "./provider-registrar.ts";
import { Logger } from "./logger.ts";
import type {
  AutoSession,
  ConvState,
  CopilotAutoOptions,
  EndpointDescriptor,
  ExtensionAPI,
  ExtensionCtx,
  LoggerLike,
  WirePayload,
} from "./types.ts";

const DEFAULT_PROBE_TIMEOUT_MS = 2_000;

/** Payload shape as delivered by emitBeforeProviderRequest. */
interface BeforeProviderRequestEvent {
  payload?: WirePayload;
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
  /** Catalog-level probe result — only seeds the session it was minted for
   *  (Copilot-Session-Token is conversation-scoped). */
  private seededSession?: AutoSession;
  private seededSessionId?: string;
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
    this.client = new CapiClient(this.logger, { apiVersion: options.apiVersion });
    this.store = new ConvStateStore(this.client, this.logger, options.refreshSkewMs);
    this.registrar = new ProviderRegistrar(this.client, this.logger, options.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS);
    const tokenProvider: TokenProvider = {
      takeTokenForWireModel: (wireModel) => this.pendingTokens.take(wireModel),
    };
    this.fetchPatch = new FetchPatch(tokenProvider, (msg) => this.logger.log(msg));
  }

  register(): void {
    // Load-phase provider registration: the host resolves the initial
    // `--model` / session model scope BEFORE session_start fires, so the
    // shell model must be registered here (credential deferred — stored
    // OAuth resolves lazily through the unchanged provider id). The
    // session_start handler below re-anchors it (probe → wholesale
    // replacement, no stale entries).
    this.registrar.registerDefault(this.pi);

    // Hook registration at load; the fetch patch is installed per session
    // (below) so it nests over whatever fetch OMP core has by session
    // start rather than bypassing later core middleware.
    this.pi.on("session_start", async (_event, ctx) => {
      this.fetchPatch.install();
      await this.ensureRegistered(ctx);
      ctx.ui.setStatus("copilot-auto", this.descriptor ? `ready (${this.descriptor.api})` : "idle");
    });

    this.pi.on("input", async (event, ctx) => {
      // Interactive path: the editor emits `input` with the submitted
      // text; it always precedes the provider request it feeds (DESIGN
      // §3 chat.message equivalent). RPC turns never reach this hook.
      const raw = event as { text?: unknown; images?: unknown };
      this.capturePrompt(raw.text, raw.images, ctx);
    });

    this.pi.on("before_agent_start", async (event, ctx) => {
      // RPC / non-interactive path: AgentSession.prompt() emits
      // before_agent_start { prompt, images, systemPrompt } instead of
      // `input` (OMP 18 ExtensionRunner.emitBeforeAgentStart), and the
      // extension ctx exposes sessionManager like every other hook.
      // Capturing here (this fires BEFORE before_provider_request for the
      // same turn) stops the intent router from seeing prompt=false on
      // RPC turns. Interactive turns fire both hooks with the same text;
      // the last write wins with identical content.
      const raw = event as { prompt?: unknown; images?: unknown };
      this.capturePrompt(raw.prompt, raw.images, ctx);
    });

    this.pi.on("before_provider_request", async (event, ctx) => {
      return await this.routeRequest(event as BeforeProviderRequestEvent, ctx);
    });

    this.pi.on("session_before_compact", async (event) => {
      const raw = event as { sessionId?: unknown };
      const sessionId = typeof raw.sessionId === "string" ? raw.sessionId : undefined;
      this.store.markNeedsReEval(sessionId);
      // Drop the compacted conversation's pending tokens AND any retry
      // leases: a token minted pre-compaction must not stamp a
      // post-compaction request (fail closed when no session id is
      // carried — the event targets every conversation then).
      if (sessionId) {
        this.pendingTokens.clearForSession(sessionId);
      } else {
        this.pendingTokens.clear();
      }
      this.fetchPatch.clearLeases();
    });

    this.pi.on("session_shutdown", async () => {
      // Session teardown: restore the fetch captured at session_start and
      // drop every queued token/lease. The next session_start recaptures
      // the host's THEN-current fetch wrapper (never bypassing middleware
      // added mid-session) and no token from a dead conversation can
      // stamp a request in the next session.
      this.fetchPatch.restore();
      this.pendingTokens.clear();
    });

    this.pi.on("credential_disabled", async () => {
      // Re-arm registration: the next session_start re-resolves the
      // credential and re-registers the shell model (DESIGN §9.4). The
      // probe session belonged to the disabled credential — drop it too.
      this.registrar.reset();
      this.bearer = undefined;
      this.seededSession = undefined;
      this.seededSessionId = undefined;
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
    if (Array.isArray(images)) conv.referenceCount = images.length;
  }

  // ── registration ──────────────────────────────────────────────────

  private async ensureRegistered(ctx: ExtensionCtx): Promise<void> {
    if (!ctx.modelRegistry) {
      this.logger.log("no modelRegistry in context; registration skipped");
      return;
    }
    try {
      const result = await this.registrar.register(this.pi, ctx);
      if (result.registered && result.descriptor) {
        this.descriptor = result.descriptor;
        this.router = this.registrar.routerFor(result.descriptor, { intentTimeoutMs: this.options.intentTimeoutMs });
        this.seededSession = result.seededSession;
        this.seededSessionId = result.seededSessionId;
        this.bearer = result.bearer;
      }
    } catch (error) {
      // Registration must never break the session; the idempotent
      // registrar retries on the next session_start or turn.
      this.logger.log(`registration failed: ${String(error)}`);
    }
  }

  // ── per-turn routing ──────────────────────────────────────────────

  private async routeRequest(
    event: BeforeProviderRequestEvent,
    ctx: ExtensionCtx,
  ): Promise<WirePayload | undefined> {
    const payload = event.payload;
    if (!payload || payload.model !== AUTO_MODEL_ID) return undefined;

    try {
      // Hard guard against the session_start race: registration normally
      // runs there, but the anchor probe takes up to probeTimeoutMs and
      // the first before_provider_request can fire before it settles.
      // Drive registration from here too — the registrar is idempotent
      // and single-flighted, so both paths share one registration.
      await this.ensureRegistered(ctx);
      if (!this.router || !this.descriptor) {
        this.logger.log("routing skipped: auto model not registered (no credential or registration failed)");
        return undefined;
      }
      const router = this.router;

      const sessionId = ctx.sessionManager?.getSessionId?.() ?? "unknown-session";
      const conv: ConvState = this.store.get(sessionId, AUTO_MODEL_ID);
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

      payload.model = verdict.decided;
      router.applyReasoningBoost(payload, verdict.decided, verdict.label);

      // Commit BEFORE returning: OMP sends the returned payload only after
      // this handler resolves, and the fetch patch fires synchronously at
      // send-time (one turn per state machine — no concurrent request).
      this.store.commitRouting(conv, verdict.decided, verdict.label, verdict.omitSessionToken, verdict.confidence);

      // Queue this turn's token for the fetch patch (DESIGN §6), right
      // before the payload is returned: the hook resolves before the
      // transport sends, so the next request for this wire model consumes
      // THIS turn's token. FIFO per model keeps concurrent sessions
      // routing the same model from cross-stamping; pool-excluded routes
      // (omitSessionToken) never queue a token.
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
      // One-time toasts only: turn-0 reroute and post-compaction reroute
      // (DESIGN §9.5 — no per-turn toast spam).
      if (verdict.source === "intent" && (isTurnZero || wasCompactionReroute)) {
        ctx.ui.notify?.(`Auto → ${verdict.decided} · ${verdict.label ?? "no label"}`, "info");
      }
      return payload;
    } catch (error) {
      // Routing must never break the turn: pass the original payload through.
      this.logger.log(`routing error, passing payload through: ${String(error)}`);
      return undefined;
    }
  }
}