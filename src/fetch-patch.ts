/**
 * copilot-auto — globalThis.fetch patch.
 *
 * OMP has no chat.headers-grade extension seam (DESIGN.md §6), so the
 * Copilot-Session-Token is stamped here, on the process-global fetch used
 * by every transport at call time. OMP core itself ships the same pattern
 * (`globalThis.fetch = wrap(globalThis.fetch)`), confirming it is a safe
 * in-process convention.
 *
 *   - Intercepts only POSTs to the Copilot chat hosts
 *     (api.githubcopilot.com / api.individual.githubcopilot.com) on any
 *     supported chat path (/chat/completions, /v1/messages, /responses).
 *   - The token is supplied by a TokenProvider that CONSUMES a pending
 *     token queued per wire model id by the routing hook immediately
 *     before each request is dispatched — never selected from a scan of
 *     conversation state, so concurrent sessions routing the same model
 *     each get their own token (FIFO per model).
 *   - Intercepts only POSTs to api.githubcopilot.com chat endpoints.
 *   - The token is supplied by a TokenProvider that CONSUMES a pending
 *     token queued per wire model id by the routing hook immediately
 *     before each request is dispatched — never selected from a scan of
 *     conversation state, so concurrent sessions routing the same model
 *     each get their own token (FIFO per model).
 *   - A retried chat POST (byte-identical URL+body) REUSES the token it
 *     was already stamped with instead of consuming a token queued for
 *     another session: tokens are leased per request fingerprint, one
 *     lease per stamped exchange. A lease is reused only after its
 *     exchange threw or returned 429/5xx (a transport retry); while
 *     in-flight it is NOT reused, so two genuinely concurrent
 *     byte-identical requests (two sessions, same prompt) each consume
 *     their own queued token and stamp A and B, never A twice. A request
 *     whose exchange already completed never takes a fresh token — it
 *     fails closed (no stamp) rather than cross-stamping a different
 *     conversation.
 *   - NEVER logs tokens; failures fall through to the original fetch.
 */

import { RequestLeaseTable, type RequestLease } from "./request-lease-table.ts";

export interface TokenProvider {
  /**
   * Return and consume the pending Copilot-Session-Token for an outgoing
   * chat request, or undefined to send without one (pool-excluded / no
   * pending turn). Tokens are queued per wire model id by the routing
   * hook right before the request is sent, so the consumed token is
   * always the in-flight turn's — never another session's.
   */
  takeTokenForWireModel(wireModelId: string | undefined): string | undefined;
}

export class FetchPatch {
  private installed = false;
  private original: typeof fetch | undefined;
  /** Per-fingerprint request leases: a retried request (same URL+body)
   *  reuses its OWN stamped token after a throw/429/5xx, while a
   *  concurrent byte-identical request — every lease in-flight — takes a
   *  fresh queued token and opens its own lease. Session-scoped: cleared
   *  on install/restore and on compaction. Tokens never logged. */
  private readonly lease = new RequestLeaseTable();

  constructor(
    private readonly provider: TokenProvider,
    private readonly log: (msg: string) => void,
  ) {}

  /**
   * Install once; idempotent. The original fetch is captured AT INSTALL
   * TIME, so installing on session_start (after OMP core has wrapped
   * fetch during session init) nests over the host's wrapper instead of
   * bypassing later core middleware. Must run before the first chat
   * dispatch of a session.
   */
  install(): void {
    if (this.installed) return;
    const original = globalThis.fetch;
    this.installed = true;
    this.original = original;
    this.lease.clear();
    const provider = this.provider;
    const log = this.log;
    const lease = this.lease;
    const patched = async (
      input: string | URL | Request,
      init?: RequestInit,
    ): Promise<Response> => {
      let fingerprint: string | undefined;
      let leaseEntry: RequestLease | undefined;
      let token: string | undefined;
      try {
        const url = FetchPatch.requestUrl(input);
        if (
          url !== undefined &&
          FetchPatch.isCopilotChatHost(url.hostname) &&
          (init?.method ?? "GET") === "POST" &&
          !url.pathname.startsWith("/models/session")
        ) {
          const wireModel = FetchPatch.wireModelFromBody(init?.body);
          // SHA-256 over method+URL+body — async, so concurrent identical
          // requests resume after it one at a time. The lease decision
          // below is fully synchronous (no awaits between the digest and
          // the hold), so the first request to resume claims its lease
          // before the second resumes: the digest can never let two
          // requests both see an empty table for the same fingerprint.
          fingerprint = await FetchPatch.fingerprint(input, init);
          if (fingerprint !== undefined) {
            // Reuse ONLY a non-active lease — a prior attempt of THIS
            // request that threw or returned 429/5xx — so a transport
            // retry gets its own token back without consuming one queued
            // for another session. If every lease is still in-flight,
            // this is a genuinely concurrent identical request: consume
            // a fresh queued token and open a second lease (A and B,
            // never A twice). Fail closed when neither exists.
            leaseEntry = lease.reuse(fingerprint);
            if (leaseEntry !== undefined) {
              token = leaseEntry.token;
            } else {
              token = provider.takeTokenForWireModel(wireModel);
              if (token !== undefined) leaseEntry = lease.hold(fingerprint, token);
            }
          } else {
            // No usable URL fingerprint (unreachable for a chat POST):
            // stamp a fresh queued token without a lease.
            token = provider.takeTokenForWireModel(wireModel);
          }
          if (token !== undefined) {
            // Headers may arrive as a plain object or a Headers instance;
            // merge through Headers so neither path loses existing headers.
            const headers = new Headers(init?.headers);
            headers.set("Copilot-Session-Token", token);
            init = { ...init, headers };
            log(`fetch patch: stamped Copilot-Session-Token for ${wireModel ?? "?"}`);
          }
        }
      } catch (error) {
        // The patch must never break normal traffic.
        log(`fetch patch error (passing through): ${String(error)}`);
      }
      if (token === undefined) return original(input, init);
      let response: Response;
      try {
        response = await original(input, init);
      } catch (error) {
        // A thrown exchange keeps its lease (retryable) so the transport
        // retry of THIS request reuses its own token. Re-throw untouched.
        if (leaseEntry !== undefined) lease.makeRetryable(leaseEntry);
        throw error;
      }
      if (fingerprint !== undefined && leaseEntry !== undefined) {
        if (FetchPatch.isRetryableStatus(response.status)) {
          // 429/5xx: a retry of this request is plausible — keep the
          // lease so it reuses its own token instead of stealing another
          // session's queued token.
          lease.makeRetryable(leaseEntry);
        } else {
          // 2xx/4xx≠429: the exchange completed — spend ONLY this lease.
          // A later byte-identical request is a new turn and takes a
          // fresh queued token; concurrent leases under the same
          // fingerprint survive.
          lease.release(fingerprint, leaseEntry);
        }
      }
      return response;
    };
    // bun's typeof fetch carries static members (preconnect) a plain
    // function cannot satisfy; the monkeypatch contract only needs the
    // call signature, so the cast is deliberate.
    globalThis.fetch = patched as unknown as typeof fetch;
  }

  /** Restore the fetch captured at install time (tests / shutdown). */
  restore(): void {
    if (!this.installed || !this.original) return;
    globalThis.fetch = this.original;
    this.installed = false;
    this.original = undefined;
    this.lease.clear();
  }

  /** Drop every retry lease (compaction / session teardown): a token
   *  leased before a lifecycle boundary must not be reused after it. */
  clearLeases(): void {
    this.lease.clear();
  }


  private static requestUrl(input: string | URL | Request): URL | undefined {
    try {
      if (typeof input === "string") return new URL(input);
      if (input instanceof URL) return input;
      const maybe = input as Partial<Request>;
      return typeof maybe.url === "string" ? new URL(maybe.url) : undefined;
    } catch {
      return undefined;
    }
  }

  /** The Copilot chat hosts the session token is valid for: the generic
   *  host and the account-specific one the current GPT/MAI/Gemini
   *  catalog entries are served from (openai-responses chat goes to
   *  {baseUrl}/responses on either). Exact match — never a suffix, so a
   *  look-alike hostname can not be stamped. */
  private static isCopilotChatHost(hostname: string): boolean {
    return hostname === "api.githubcopilot.com" || hostname === "api.individual.githubcopilot.com";
  }

  /** Chat POST bodies are string JSON with a top-level `model` field. */
  private static wireModelFromBody(body: unknown): string | undefined {
    if (typeof body !== "string") return undefined;
    try {
      const parsed: unknown = JSON.parse(body);
      if (typeof parsed === "object" && parsed !== null && "model" in parsed) {
        const model: unknown = parsed.model;
        return typeof model === "string" ? model : undefined;
      }
    } catch {}
    return undefined;
  }

  /**
   * Stable identity of one outgoing chat request: SHA-256 over
   * method + URL + raw body. A transport retry re-serializes the same
   * payload, so the digest matches and the retry reuses its own token;
   * any other request (different body) misses and takes a fresh queued
   * token. Undefined when the input carries no usable URL.
   */
  private static async fingerprint(
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<string | undefined> {
    let url: string | undefined;
    if (typeof input === "string") url = input;
    else if (input instanceof URL) url = input.href;
    else {
      const maybe = input as Partial<Request>;
      url = typeof maybe.url === "string" ? maybe.url : undefined;
    }
    if (url === undefined) return undefined;
    const body = typeof init?.body === "string" ? init.body : "";
    const method = init?.method ?? "GET";
    const data = new TextEncoder().encode(`${method} ${url}\n${body}`);
    const digest = await crypto.subtle.digest("SHA-256", data);
    return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
  }

  /** Statuses after which a transport retry of the same request is plausible. */
  private static isRetryableStatus(status: number): boolean {
    return status === 429 || status >= 500;
  }
}
