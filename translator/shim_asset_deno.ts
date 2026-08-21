// The Deno arm of @polyengine/translator, reached from mod.ts via a
// STRING-LITERAL dynamic import: the literal specifier puts this module —
// and the wasm it statically imports — into the statically-analyzable
// module graph, so no read permission is needed (unlike a computed
// `import(url)`, which Deno gates); the dynamic edge keeps it lazy, and
// non-Deno platforms never evaluate it. The static wasm import instantiates
// the zero-import shim under Deno's ESM integration when this module first
// evaluates.

import * as ns from "./translator_shim.wasm";

export { ns };
