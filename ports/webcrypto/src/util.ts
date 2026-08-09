// Shared helpers for the `polymorph:webcrypto` port: byte-stream ingestion
// and JWK plumbing, ported from js/jco/webcrypto.js's `collectByteStream`
// and JWK-material helpers.
//
// Stream ingestion: a guest-provided `stream<u8>` arrives as this repo's
// `Stream<T>` handle (contracts/embedder-api.md §"Streams and futures":
// `read(max): Promise<Chunk<T>>`, an empty chunk meaning end-of-stream) —
// not jco's async-iterable convention, so this collector is written
// directly against `Stream<number>.read`, no jco-shape tolerance needed.

import type { Stream } from "../../../runtime/src/embedder/mod.ts";
import { errInvalidKey } from "./errors.ts";

/** Read a guest `stream<u8>` to completion, copying chunks into one buffer. */
export async function collectByteStream(data: Stream<number>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  // deno-lint-ignore no-constant-condition
  while (true) {
    const chunk = await data.read(65536);
    const len = (chunk as { length: number }).length;
    if (len === 0) break;
    const bytes = chunk instanceof Uint8Array ? chunk : Uint8Array.from(chunk as number[]);
    chunks.push(bytes);
    total += bytes.length;
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}

/** Narrow a lifted `list<u8>` to the `BufferSource` WebCrypto takes (always a fresh copy per the value-mapping table, so this is a type-level cast only). */
export function asBufferSource(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  return bytes as Uint8Array<ArrayBuffer>;
}

const utf8Encoder = new TextEncoder();
const utf8Decoder = new TextDecoder("utf-8", { fatal: true });

export function utf8Encode(s: string): Uint8Array {
  return utf8Encoder.encode(s);
}

export function utf8Decode(bytes: Uint8Array): string {
  try {
    return utf8Decoder.decode(bytes);
  } catch {
    errInvalidKey("unwrapped material is not valid UTF-8");
  }
}

/**
 * Parse an unwrap-input's bytes as JWK text and validate the `use`/
 * `key_ops` members in the caller's stead (the unwrap-path JWK contract;
 * reference: js/jco/webcrypto.js `unwrappedJwk`, lines 1238-1280). Both
 * members are stripped from the result, as on the import path.
 */
export function unwrappedJwk(bytes: Uint8Array, family: "enc" | "sig", grantedOps: string[]): string {
  const text = utf8Decode(bytes);
  let jwk: unknown;
  try {
    jwk = JSON.parse(text);
  } catch {
    return errInvalidKey("unwrapped JWK is not valid JSON");
  }
  if (typeof jwk !== "object" || jwk === null || Array.isArray(jwk)) {
    errInvalidKey("unwrapped JWK must be a JSON object");
  }
  const { use, key_ops, ...material } = jwk as Record<string, unknown>;
  if (use !== undefined && use !== family) {
    errInvalidKey("unwrapped JWK `use` does not match the key's family");
  }
  if (key_ops !== undefined) {
    if (!Array.isArray(key_ops) || !grantedOps.every((op) => (key_ops as unknown[]).includes(op))) {
      errInvalidKey("unwrapped JWK `key_ops` does not cover the granted usages");
    }
  }
  return JSON.stringify(material);
}
