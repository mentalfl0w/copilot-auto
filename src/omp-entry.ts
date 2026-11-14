import { createAssistantMessageEventStream, streamSimple, type AssistantMessageEventStream } from "@oh-my-pi/pi-ai";
import type { ExtensionAPI } from "./types.ts";
import copilotAuto from "./index.ts";

/**
 * OMP's public AI package exports the stream class but not Pi's lazyStream
 * helper, so keep the small forwarding adapter at the host-specific edge.
 */
function lazyStream(_model: unknown, setup: () => Promise<unknown>): AssistantMessageEventStream {
  const outer = createAssistantMessageEventStream();
  void setup()
    .then(async (source) => {
      if (!source || typeof (source as AsyncIterable<unknown>)[Symbol.asyncIterator] !== "function") {
        throw new Error("OMP native stream delegate returned a non-stream value");
      }
      const iterable = source as AsyncIterable<unknown> & { result?: () => Promise<unknown> };
      for await (const event of iterable) outer.push(event as never);
      const result = typeof iterable.result === "function" ? await iterable.result() : undefined;
      outer.end(result as never);
    })
    .catch((error) => outer.fail(error));
  return outer;
}

/** OMP host entry: install host-native helpers before core startup. */
export default async function ompCopilotAuto(pi: ExtensionAPI): Promise<void> {
  pi.lazyStream = lazyStream;
  pi.streamSimple = streamSimple as unknown as ExtensionAPI["streamSimple"];
  await copilotAuto(pi);
}
