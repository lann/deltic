// wasi:filesystem@0.2 — types (minimal), preopens (contracts/embedder-api.md
// §"WASI examination", filesystem scope).

import { assertEq, assertThrows } from "./asserts.ts";
import { Descriptor, filesystem } from "../src/filesystem.ts";

Deno.test("filesystem: preopens#get-directories returns []", () => {
  const { imports } = filesystem();
  const preopens = imports["wasi:filesystem/preopens@0.2"] as {
    getDirectories(): unknown[];
  };
  assertEq(preopens.getDirectories().length, 0);
});

Deno.test("filesystem: Descriptor is constructible-never", () => {
  assertThrows(() => new Descriptor());
});

Deno.test("filesystem: filesystem-error-code always downcasts to none", () => {
  const { imports } = filesystem();
  const types = imports["wasi:filesystem/types@0.2"] as {
    filesystemErrorCode(err: unknown): unknown;
  };
  assertEq(types.filesystemErrorCode({}), undefined);
});
