// `polymorph:webcrypto/sha1-checked` — wit/sha1.wit, `@unstable(feature =
// sha1-checked)`.
//
// This interface is fail-closed by construction here. Its two postures
// (rejecting / mitigating) both require sha1dc collision detection, which
// NO platform WebCrypto carries — the WIT's own note: "platform-backed
// providers cannot serve this interface". A platform-backed host that
// answered anyway would be returning a plain SHA-1 digest under a name
// that promises attack detection, so both mints decline with
// `error.unsupported` instead (reference: js/jco/webcrypto.js:2445-2453,
// the same decline).
//
// The interface is nonetheless PROVIDED (rather than left unlinked) so a
// component importing it instantiates: the conformance target declares
// `sha1-checked` in its missing-features list, and the suite's
// `!sha1-checked` decline case asserts the refusal actually works.

import { errUnsupported } from "./errors.ts";
import type { Digest } from "./digest.ts";

function unsupportedSha1Checked(): never {
  errUnsupported("sha1-checked is not served by this implementation");
}

/** The `polymorph:webcrypto/sha1-checked@0.1.0` interface. */
export const sha1Checked = {
  makeRejectingDigest: (): Digest => unsupportedSha1Checked(),
  makeMitigatingDigest: (): Digest => unsupportedSha1Checked(),
};
