// Minimal `Stream<number>`-shaped test double: the port's stream-consuming
// functions (`collectByteStream`) only call `.read(max)`, so a fake
// implementing that one method is sufficient and avoids depending on the
// runtime's full stream/store machinery for unit tests (the exec-model
// integration test exercises the real `Stream<T>` handle end-to-end).

import type { Stream } from "../../../runtime/src/embedder/mod.ts";

export function arrayStream(bytes: Uint8Array): Stream<number> {
  let offset = 0;
  return {
    async read(max: number) {
      if (offset >= bytes.length) return new Uint8Array(0);
      const end = Math.min(bytes.length, offset + max);
      const chunk = bytes.slice(offset, end);
      offset = end;
      return chunk;
    },
    // deno-lint-ignore no-explicit-any
  } as any as Stream<number>;
}
