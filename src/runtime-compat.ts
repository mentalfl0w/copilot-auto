/**
 * copilot-auto — cross-runtime compatibility layer (OMP ↔ Pi).
 *
 * One bundled artifact runs under both hosts (omp-wechat pattern):
 *
 *   - Runtime discriminator: OMP injects a truthy `pi` self-reference on
 *     the ExtensionAPI; Pi does not. That single fact distinguishes the
 *     hosts at load time (runtimeKind).
 *   - Load-phase OAuth marker is OMP-ONLY. OMP's runtime registerProvider
 *     validates non-empty model lists as requiring `apiKey` or `oauth`,
 *     so the credential-less load registration carries a lightweight
 *     marker (the host resolves login/refresh from its BUILT-IN Copilot
 *     provider registry anyway). Pi's registerProvider treats a supplied
 *     `oauth` as a COMPLETE ExtensionOAuthConfig (login/refreshToken/
 *     getApiKey functions required) — a bare `{ name }` marker would
 *     replace the built-in GitHub Copilot OAuth with a broken partial
 *     config. On Pi the marker is OMITTED so Pi composes its built-in
 *     `github-copilot` OAuth provider.
 *   - Catalog adapter: OMP exposes the live registry view as
 *     ctx.models.list(); Pi exposes ctx.modelRegistry.getAll() (full
 *     registry snapshot) and ctx.scopedModels (session-scoped entries).
 *     All three surfaces carry provider/id/api/baseUrl per model, which
 *     is all catalogDescriptors needs for endpoint-exact routing.
 *   - Credential adapter: both hosts expose
 *     ctx.modelRegistry.getApiKeyForProvider (Pi's synchronous facade
 *     takes just the provider id; extra args are ignored). Pi's
 *     getProviderAuth()?.auth?.apiKey is the fallback for hosts without
 *     getApiKeyForProvider. Credentials are never logged.
 *
 * No `@oh-my-pi` / `@earendil-works` import: the host API is consumed
 * through structural interfaces (types.ts), so the bundle loads in both
 * runtimes with zero host-specific imports and works under Node.js/jiti
 * (Pi) exactly as under the Bun-based OMP binary.
 */

import type { CopilotCatalogModel, ExtensionCtx } from "./types.ts";

/** The two hosts the bundle runs under. */
export type RuntimeKind = "omp" | "pi";

/**
 * Runtime discriminator (omp-wechat convention): OMP injects a truthy
 * `pi` self-reference on the ExtensionAPI; Pi does not. Truthy → OMP,
 * falsy/absent → Pi.
 */
export function runtimeKind(api: { pi?: unknown }): RuntimeKind {
  return api.pi ? "omp" : "pi";
}

/**
 * Load-phase `oauth` marker for the credential-less registration.
 * OMP: `{ name: "GitHub Copilot" }` satisfies the host's "apiKey or
 * oauth required when defining models" validation without shadowing the
 * built-in Copilot OAuth descriptor (the host consults its built-in
 * provider registry first for login/refresh). Pi: undefined — Pi's
 * registerProvider would adapt a supplied `oauth` as a COMPLETE
 * ExtensionOAuthConfig (login/refreshToken/getApiKey), so the bare
 * marker would break the built-in OAuth; omitting it makes Pi inherit
 * its built-in `github-copilot` OAuth provider.
 */
export function loadPhaseOAuth(kind: RuntimeKind): { name: string } | undefined {
  return kind === "omp" ? { name: "GitHub Copilot" } : undefined;
}

/**
 * Catalog model entries (provider/id/api/baseUrl per model) from
 * whichever surface the host exposes:
 *   1. OMP: ctx.models.list() — the live registry view (catalog +
 *      registered models), preferred when present;
 *   2. Pi: ctx.modelRegistry.getAll() — full registry snapshot;
 *   3. Pi: ctx.scopedModels — session-scoped `{ model }` entries
 *      (never both 2 and 3 on one host, but the fallback chain is safe
 *      on any mix).
 * Empty results fall through — a host with an empty view still gets a
 * chance to supply entries from the next surface.
 */
export function catalogModelEntries(ctx: ExtensionCtx): CopilotCatalogModel[] {
  const fromModels = ctx.models?.list?.() ?? [];
  if (fromModels.length > 0) return fromModels;
  const fromRegistry = ctx.modelRegistry?.getAll?.() ?? [];
  if (fromRegistry.length > 0) return fromRegistry;
  const scoped = ctx.scopedModels ?? [];
  const out: CopilotCatalogModel[] = [];
  for (const entry of scoped) {
    if (entry && typeof entry === "object" && "model" in entry) {
      const model = entry.model;
      if (isCatalogModel(model)) out.push(model);
    }
  }
  return out;
}

/** Structural guard: a scopedModels entry's model carries an id (the
 *  downstream catalog consumer validates the remaining fields). */
function isCatalogModel(value: unknown): value is CopilotCatalogModel {
  return typeof value === "object" && value !== null && "id" in value;
}

/** Structural subset of the credential-resolution surface (types.ts
 *  modelRegistry). Keep the adapter duck-typed — never `any`. */
export interface CredentialRegistry {
  getApiKeyForProvider?(providerId: string, sessionId?: string, opts?: unknown): Promise<string | undefined>;
  getProviderAuth?(providerId: string): Promise<{ auth?: { apiKey?: string } } | undefined>;
}

/**
 * Resolve the provider's bearer credential. Prefers the shared
 * getApiKeyForProvider (current OMP and Pi both expose it); falls back
 * to Pi's getProviderAuth()?.auth?.apiKey when the primary is absent or
 * fails. Returns undefined when nothing is resolvable — the extension
 * stays idle until the credential is re-enabled (issue #1 lesson: load
 * must succeed with no auth). The credential is never logged.
 */
export async function resolveProviderCredential(
  registry: CredentialRegistry | undefined,
  providerId: string,
  sessionId: string | undefined,
): Promise<string | undefined> {
  if (!registry) return undefined;
  try {
    const key = await registry.getApiKeyForProvider?.(providerId, sessionId);
    if (key) return key;
  } catch {
    // Fall through to the secondary surface.
  }
  try {
    return (await registry.getProviderAuth?.(providerId))?.auth?.apiKey;
  } catch {
    return undefined;
  }
}
