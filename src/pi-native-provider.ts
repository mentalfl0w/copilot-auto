import type { ReasoningBucket } from "./types.ts";

/**
 * Pi native-style provider wrapper.
 *
 * Session creation and routing are injected. The host supplies lazyStream so
 * asynchronous routing still returns a real Provider stream synchronously.
 */

export interface Model {
  id: string;
  name?: string;
  [key: string]: unknown;
}

export interface PiProvider {
  id?: string;
  name?: string;
  baseUrl?: string;
  headers?: Record<string, string>;
  auth?: unknown;
  getModels(): readonly Model[];
  stream(model: Model, context: unknown, options?: unknown): unknown;
  streamSimple(model: Model, context: unknown, options?: unknown): unknown;
  filterModels?(models: readonly Model[], credential?: unknown): readonly Model[];
  refreshModels?(context?: unknown): void | Promise<void>;
}

export interface RoutePlan {
  realModelId: string;
  api: string;
  baseUrl?: string;
  sessionToken?: string;
  interactionId?: string;
  reasoningBucket?: ReasoningBucket;
  source: string;
  omitSessionToken?: boolean;
}

export type RouteResolver = (
  managedModelId: string,
  context: unknown,
  options?: unknown,
) => Promise<RoutePlan>;

export type NativeStreamSimple = (
  model: Model,
  context: unknown,
  options?: { headers?: Record<string, string>; [key: string]: unknown },
) => unknown;

export type LazyStream = (model: Model, setup: () => Promise<unknown>) => unknown;

export interface WrapPiProviderOptions {
  template: Model;
  /** Complete host catalog snapshot when the provider overlay hides built-ins. */
  catalog?: readonly Model[];
  visiblePool: readonly string[];
  getVisiblePool?: () => readonly string[];
  routeResolver: RouteResolver;
  nativeStreamSimple: NativeStreamSimple;
  lazyStream: LazyStream;
  headers?: Record<string, string>;
}

function isAutoId(id: string): boolean {
  return id === "auto" || id.startsWith("auto-");
}

function targetForAlias(id: string): string | undefined {
  return id === "auto" ? undefined : id.slice("auto-".length);
}

function buildAliasTargets(pool: readonly string[], models: readonly Model[]): Map<string, string> {
  const baseIds = new Set(models.map((model) => model.id));
  const aliases = new Map<string, string>();
  for (const realId of pool) {
    if (!realId || realId.startsWith("auto-") || !baseIds.has(realId)) continue;
    aliases.set(`auto-${realId}`, realId);
  }
  return aliases;
}
function mergeRouteOptions(
  plan: RoutePlan,
  callerOptions: unknown,
  providerHeaders?: Record<string, string>,
): { headers?: Record<string, string>; [key: string]: unknown } {
  const caller = callerOptions && typeof callerOptions === "object"
    ? callerOptions as Record<string, unknown>
    : {};
  const callerHeaders = caller.headers && typeof caller.headers === "object"
    ? caller.headers as Record<string, string>
    : {};
  const headers: Record<string, string> = {};
  if (callerHeaders instanceof Headers) {
    callerHeaders.forEach((value, name) => { headers[name] = value; });
  } else {
    Object.assign(headers, callerHeaders);
  }
  const removeRouteHeader = (name: string): void => {
    const lowerName = name.toLowerCase();
    for (const existingName of Object.keys(headers)) {
      if (existingName.toLowerCase() === lowerName) delete headers[existingName];
    }
  };
  const setRouteHeader = (name: string, value: string): void => {
    removeRouteHeader(name);
    headers[name] = value;
  };
  if (providerHeaders) {
    for (const [name, value] of Object.entries(providerHeaders)) setRouteHeader(name, value);
  }
  if (plan.sessionToken && !plan.omitSessionToken) {
    setRouteHeader("Copilot-Session-Token", plan.sessionToken);
  } else {
    removeRouteHeader("Copilot-Session-Token");
  }
  if (plan.interactionId) setRouteHeader("X-Interaction-Id", plan.interactionId);
  const merged: { headers?: Record<string, string>; [key: string]: unknown } = {
    ...caller,
    headers,
  };
  if (plan.reasoningBucket) merged.reasoning = plan.reasoningBucket;
  return merged;
}

export function wrapPiProvider(base: PiProvider, options: WrapPiProviderOptions): PiProvider {
  const getPool = options.getVisiblePool ?? (() => options.visiblePool);

  function allModels(): Model[] {
    const byId = new Map<string, Model>();
    for (const model of base.getModels()) {
      if (!isAutoId(model.id)) byId.set(model.id, model);
    }
    for (const model of options.catalog ?? []) {
      if (!isAutoId(model.id)) byId.set(model.id, model);
    }
    return [...byId.values()];
  }

  function getModels(): readonly Model[] {
    const catalogModels = allModels();
    const aliases = buildAliasTargets(getPool(), catalogModels);
    const result: Model[] = catalogModels.map((model) => ({ ...model }));
    result.push({ ...options.template, id: "auto", name: options.template.name ?? "Auto (Copilot)" });

    for (const [aliasId, realId] of aliases) {
      const real = catalogModels.find((model) => model.id === realId);
      if (real) result.push({ ...real, id: aliasId, name: `${real.name ?? realId} (auto)` });
    }
    return result;
  }

  async function resolveManaged(model: Model, context: unknown, callerOptions?: unknown): Promise<unknown> {
    const catalogModels = allModels();
    const aliases = buildAliasTargets(getPool(), catalogModels);
    const targetId = targetForAlias(model.id);
    if (targetId !== undefined && aliases.get(model.id) !== targetId) {
      throw new Error(`Auto alias "${model.id}" is not in the current session pool`);
    }

    const plan = await options.routeResolver(model.id, context, callerOptions);
    if (!plan || typeof plan.realModelId !== "string" || plan.realModelId.length === 0) {
      throw new Error(`Auto route for "${model.id}" returned no real model`);
    }
    if (targetId !== undefined && plan.realModelId !== targetId) {
      throw new Error(`Auto alias "${model.id}" resolved to "${plan.realModelId}" instead of "${targetId}"`);
    }

    const catalogModel = catalogModels.find((entry) => entry.id === plan.realModelId);
    const real: Model = catalogModel
      ? { ...catalogModel }
      : {
          ...options.template,
          id: plan.realModelId,
          name: plan.realModelId,
        };
    const routedModel: Model = { ...real, api: plan.api };
    if (plan.baseUrl !== undefined) routedModel.baseUrl = plan.baseUrl;
    return options.nativeStreamSimple(routedModel, context, mergeRouteOptions(plan, callerOptions, options.headers));
  }

  function stream(model: Model, context: unknown, callerOptions?: unknown): unknown {
    if (!isAutoId(model.id)) return base.stream(model, context, callerOptions);
    return options.lazyStream(model, () => resolveManaged(model, context, callerOptions));
  }

  function streamSimple(model: Model, context: unknown, callerOptions?: unknown): unknown {
    if (!isAutoId(model.id)) return base.streamSimple(model, context, callerOptions);
    return options.lazyStream(model, () => resolveManaged(model, context, callerOptions));
  }

  return {
    id: base.id,
    name: base.name,
    baseUrl: base.baseUrl,
    headers: base.headers,
    auth: base.auth,
    getModels,
    stream,
    streamSimple,
    filterModels: base.filterModels
      ? (models, credential) => base.filterModels!(models, credential)
      : undefined,
    refreshModels: base.refreshModels
      ? (context) => base.refreshModels!(context)
      : undefined,
  };
}

