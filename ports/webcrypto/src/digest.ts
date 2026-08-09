// `polymorph:webcrypto/digest` (algorithm-agnostic resource) plus
// `polymorph:webcrypto/sha2` (the SHA-2 minting interface) —
// wit/webcrypto.wit `interface digest`, wit/sha2.wit `interface sha2`.
//
// `sha1-checked` (wit/sha1.wit) is `@unstable(feature = sha1-checked)`:
// it requires sha1dc collision detection, which platform WebCrypto does
// not carry (the WIT's own note: "platform-backed providers cannot serve
// this interface"). Out of scope for this browser-first, `crypto.subtle`-
// only host — not ported, not stubbed.

import { errUnsupported, platformCall } from "./errors.ts";
import { asBufferSource, collectByteStream } from "./util.ts";
import type { Stream } from "../../../runtime/src/embedder/mod.ts";

const subtle = globalThis.crypto.subtle;

/** `digest.digest`: an algorithm-bound, reusable digest capability. */
export class Digest {
  #hashName: string;
  constructor(hashName: string) {
    this.#hashName = hashName;
  }

  async compute(data: Stream<number>): Promise<Uint8Array> {
    const message = await collectByteStream(data);
    const out = await platformCall(`${this.#hashName} digest`, () =>
      subtle.digest(this.#hashName, asBufferSource(message)));
    return new Uint8Array(out);
  }

  algorithmName(): string {
    return this.#hashName;
  }
}

/**
 * The served SHA-2 variants (wit/sha2.wit `sha2-variant`): WebCrypto
 * serves only SHA-256/384/512, matching the reference's `SHA2_VARIANTS`
 * table (js/jco/webcrypto.js:271-276) — the truncated variants
 * (sha224, sha512-224, sha512-256) are declined package-wide, per the
 * WIT doc, not a Deno-specific gap.
 */
const SHA2_HASH: Readonly<Record<string, string | undefined>> = Object.freeze({
  sha256: "SHA-256",
  sha384: "SHA-384",
  sha512: "SHA-512",
});

function sha2Hash(variant: string): string {
  const hash = SHA2_HASH[variant];
  if (hash === undefined) {
    errUnsupported(`${variant} is not served by this implementation`);
  }
  return hash;
}

/** The `polymorph:webcrypto/sha2@0.1.0` interface. */
export const sha2 = {
  makeDigest: (variant: string): Digest => new Digest(sha2Hash(variant)),
};

/** The `polymorph:webcrypto/digest@0.1.0` interface: its resource class. */
export const digest = { Digest };
