// The node backend of wasi:filesystem (filesystem_node.ts +
// fs_provider.ts), against a real tempdir through node:fs (Deno's node
// compat serves the builtin — the same backend runs on real Node via the
// pinned-Node smoke). Direct calls on the WIT-facing resource surface;
// the lift/lower path is covered by the fs-probe integration fixture.
//
// The load-bearing assertions:
//   * SYNC-NESS: every 0.2 descriptor method returns a PLAIN value (the
//     node backend's callback-mode guarantee — no parking, no JSPI).
//   * ERROR SHAPES: 0.2 err payloads are BARE enum strings ("no-entry");
//     0.3 payloads are variant records ({ kind: "no-entry" }).

import { ComponentException } from "@deltic/runtime/embedder";
import { filesystemNode } from "../src/filesystem_node.ts";
import { FsIoError } from "../src/fs_provider.ts";
import { assertEq, assertThrows, assertTrue } from "./asserts.ts";

// --- structural views of the per-call resource classes -----------------------------

type Flags = Record<string, boolean>;
interface Stat {
  type: string;
  linkCount: bigint;
  size: bigint;
  dataAccessTimestamp?: { seconds: bigint; nanoseconds: number };
  dataModificationTimestamp?: { seconds: bigint; nanoseconds: number };
}
interface Hash {
  lower: bigint;
  upper: bigint;
}
interface InStream02 {
  read(len: bigint): Uint8Array;
  blockingRead(len: bigint): Uint8Array;
}
interface OutStream02 {
  checkWrite(): bigint;
  write(b: Uint8Array): void;
  blockingFlush(): void;
}
interface DirStream02 {
  readDirectoryEntry(): { type: string; name: string } | undefined;
}
interface D02 {
  getType(): string;
  getFlags(): Flags;
  openAt(pf: Flags, path: string, of: Flags, df: Flags): D02;
  read(len: bigint, off: bigint): [Uint8Array, boolean];
  write(buf: Uint8Array, off: bigint): bigint;
  stat(): Stat;
  statAt(pf: Flags, path: string): Stat;
  readViaStream(off: bigint): InStream02;
  writeViaStream(off: bigint): OutStream02;
  appendViaStream(): OutStream02;
  readDirectory(): DirStream02;
  createDirectoryAt(p: string): void;
  removeDirectoryAt(p: string): void;
  unlinkFileAt(p: string): void;
  renameAt(o: string, d: D02, n: string): void;
  symlinkAt(t: string, p: string): void;
  readlinkAt(p: string): string;
  setSize(n: bigint): void;
  setTimes(a: unknown, m: unknown): void;
  sync(): void;
  syncData(): void;
  isSameObject(o: D02): boolean;
  metadataHash(): Hash;
  metadataHashAt(pf: Flags, p: string): Hash;
}
interface D03 {
  getType(): string;
  openAt(pf: Flags, path: string, of: Flags, df: Flags): D03 | Promise<D03>;
  stat(): Stat | Promise<Stat>;
  statAt(pf: Flags, path: string): Stat | Promise<Stat>;
  readViaStream(
    off: bigint,
  ): [AsyncIterable<Uint8Array>, Promise<{ kind: string; value?: { kind: string } }>];
  writeViaStream(
    data: unknown,
    off: bigint,
  ): Promise<{ kind: string; value?: { kind: string } }>;
  appendViaStream(data: unknown): Promise<{ kind: string; value?: { kind: string } }>;
  readDirectory():
    | [Iterable<{ type: string; name: string }>, Promise<{ kind: string }>]
    | Promise<[Iterable<{ type: string; name: string }>, Promise<{ kind: string }>]>;
}

const FOLLOW: Flags = { symlinkFollow: true };
const NOFOLLOW: Flags = {};
const RW: Flags = { read: true, write: true };

function setup(): { root02: D02; root03: D03; dir: string } {
  const dir = Deno.makeTempDirSync({ dir: "/tmp", prefix: "deltic-fs-node-" });
  const { imports } = filesystemNode({ preopens: { "/": dir } });
  const p02 = imports["wasi:filesystem/preopens@0.2"] as {
    getDirectories(): [D02, string][];
  };
  const p03 = imports["wasi:filesystem/preopens@0.3"] as {
    getDirectories(): [D03, string][];
  };
  const [[root02, name02]] = p02.getDirectories();
  const [[root03, name03]] = p03.getDirectories();
  assertEq(name02, "/");
  assertEq(name03, "/");
  return { root02, root03, dir };
}

/** The callback-mode guarantee: a plain value, not a thenable. */
function plain<T>(v: T, what: string): T {
  assertTrue(!(v instanceof Promise), `${what}: expected a plain (sync) value`);
  return v;
}

function errPayload(f: () => unknown): unknown {
  const e = assertThrows(f);
  assertTrue(e instanceof ComponentException, `expected ComponentException, got ${e}`);
  return (e as ComponentException).payload;
}

Deno.test("fs-node: preopens serve both tracks; flags reflect the grant", () => {
  const { root02, root03 } = setup();
  assertEq(plain(root02.getType(), "get-type"), "directory");
  assertEq(root03.getType(), "directory");
  const flags = root02.getFlags();
  assertTrue(flags.read && flags.write && flags.mutateDirectory, "preopen rw+mutate");
});

Deno.test("fs-node 0.2: open/write/read positional, sync throughout", () => {
  const { root02 } = setup();
  const f = plain(
    root02.openAt(FOLLOW, "hello.txt", { create: true }, RW),
    "open-at",
  );
  assertEq(f.getType(), "regular-file");
  const data = new TextEncoder().encode("hello filesystem");
  assertEq(plain(f.write(data, 0n), "write"), BigInt(data.length));
  const [bytes, eof] = plain(f.read(1024n, 0n), "read");
  assertEq(new TextDecoder().decode(bytes), "hello filesystem");
  assertEq(eof, false); // bytes came back with the read
  const [empty, eof2] = f.read(16n, BigInt(data.length));
  assertEq(empty.length, 0);
  assertEq(eof2, true);
  const st = plain(f.stat(), "stat");
  assertEq(st.type, "regular-file");
  assertEq(st.size, BigInt(data.length));
  assertTrue(st.dataModificationTimestamp !== undefined, "mtime reported");
  f.setSize(5n);
  assertEq((f.stat() as Stat).size, 5n);
});

Deno.test("fs-node 0.2: via-stream read/write/append (sync streams)", () => {
  const { root02 } = setup();
  const f = root02.openAt(FOLLOW, "s.txt", { create: true }, RW);
  const out = plain(f.writeViaStream(0n), "write-via-stream");
  assertTrue(out.checkWrite() > 0n, "permit");
  out.write(new TextEncoder().encode("abcdef"));
  plain(out.blockingFlush(), "blocking-flush");
  const app = f.appendViaStream();
  app.write(new TextEncoder().encode("-tail"));

  const src = plain(f.readViaStream(2n), "read-via-stream"); // offset 2
  assertEq(new TextDecoder().decode(plain(src.blockingRead(4n), "blocking-read")), "cdef");
  assertEq(new TextDecoder().decode(src.read(64n)), "-tail");
  // Drained + EOF = the `closed` stream-error.
  const closed = errPayload(() => src.read(1n));
  assertEq((closed as { kind: string }).kind, "closed");
});

Deno.test("fs-node 0.2: error payloads are BARE enum strings", () => {
  const { root02 } = setup();
  assertEq(errPayload(() => root02.statAt(FOLLOW, "missing")), "no-entry");
  assertEq(errPayload(() => root02.openAt(FOLLOW, "/etc/passwd", {}, RW)), "not-permitted");
  assertEq(errPayload(() => root02.statAt(FOLLOW, "../escape")), "not-permitted");
  assertEq(errPayload(() => root02.statAt(FOLLOW, "a\0b")), "invalid");
  // ".." that stays inside resolves textually.
  root02.createDirectoryAt("sub");
  const st = root02.statAt(FOLLOW, "sub/../sub");
  assertEq(st.type, "directory");
});

Deno.test("fs-node 0.2: directory ops + listing", () => {
  const { root02 } = setup();
  root02.createDirectoryAt("d");
  const f = root02.openAt(FOLLOW, "d/x.txt", { create: true }, RW);
  f.write(new Uint8Array([1, 2, 3]), 0n);
  const d = root02.openAt(FOLLOW, "d", { directory: true }, { read: true, mutateDirectory: true });
  const listing = plain(d.readDirectory(), "read-directory");
  const first = listing.readDirectoryEntry();
  assertEq(first?.name, "x.txt");
  assertEq(first?.type, "regular-file");
  assertEq(listing.readDirectoryEntry(), undefined);

  assertEq(errPayload(() => root02.removeDirectoryAt("d")), "not-empty");
  root02.renameAt("d/x.txt", root02, "y.txt");
  root02.removeDirectoryAt("d");
  root02.unlinkFileAt("y.txt");
  assertEq(errPayload(() => root02.statAt(FOLLOW, "y.txt")), "no-entry");
});

Deno.test("fs-node 0.2: symlinks, follow vs nofollow, readlink", () => {
  const { root02 } = setup();
  const f = root02.openAt(FOLLOW, "target.txt", { create: true }, RW);
  f.write(new TextEncoder().encode("x"), 0n);
  root02.symlinkAt("target.txt", "link");
  assertEq(root02.readlinkAt("link"), "target.txt");
  assertEq(root02.statAt(FOLLOW, "link").type, "regular-file");
  assertEq(root02.statAt(NOFOLLOW, "link").type, "symbolic-link");
});

Deno.test("fs-node 0.2: identity — metadata-hash and is-same-object", () => {
  const { root02 } = setup();
  root02.openAt(FOLLOW, "a.txt", { create: true }, RW);
  root02.openAt(FOLLOW, "b.txt", { create: true }, RW);
  const a1 = root02.openAt(FOLLOW, "a.txt", {}, { read: true });
  const a2 = root02.openAt(FOLLOW, "a.txt", {}, { read: true });
  const b = root02.openAt(FOLLOW, "b.txt", {}, { read: true });
  assertEq(plain(a1.isSameObject(a2), "is-same-object"), true);
  assertEq(a1.isSameObject(b), false);
  const h1 = plain(a1.metadataHash(), "metadata-hash");
  const h2 = a2.metadataHash();
  assertTrue(h1.lower === h2.lower && h1.upper === h2.upper, "same object, same hash");
  const hb = b.metadataHash();
  assertTrue(h1.lower !== hb.lower || h1.upper !== hb.upper, "different objects differ");
  const hAt = root02.metadataHashAt(FOLLOW, "a.txt");
  assertEq(hAt.lower, h1.lower);
});

Deno.test("fs-node 0.3: stream tuples and variant error shapes", async () => {
  const { root03 } = setup();
  const f = await root03.openAt(FOLLOW, "three.txt", { create: true }, RW);

  // write-via-stream: the promise IS the future (A12).
  const wrote = await f.writeViaStream(
    (async function* () {
      yield new TextEncoder().encode("stream");
      yield new TextEncoder().encode("-payload");
    })(),
    0n,
  );
  assertEq(wrote.kind, "ok");
  await f.appendViaStream((async function* () {
    yield new TextEncoder().encode("!");
  })());

  // read-via-stream: tuple<stream<u8>, future<result<_, error-code>>>.
  const [source, done] = f.readViaStream(0n);
  const chunks: Uint8Array[] = [];
  for await (const c of source) chunks.push(c);
  const text = new TextDecoder().decode(
    new Uint8Array(chunks.flatMap((c) => [...c])),
  );
  assertEq(text, "stream-payload!");
  assertEq((await done).kind, "ok");

  // read-directory: tuple<stream<directory-entry>, future<...>>.
  const [entries, listDone] = await root03.readDirectory();
  assertEq([...entries].filter((e) => e.name === "three.txt").length, 1);
  assertEq((await listDone).kind, "ok");

  // 0.3 err payloads are VARIANT records.
  try {
    await root03.statAt(FOLLOW, "missing");
    throw new Error("expected a throw");
  } catch (e) {
    assertTrue(e instanceof ComponentException, `expected ComponentException, got ${e}`);
    assertEq(((e as ComponentException).payload as { kind: string }).kind, "no-entry");
  }
});

Deno.test("fs-node: filesystem-error-code downcasts our stream errors only", () => {
  const { imports } = filesystemNode({
    preopens: { "/": Deno.makeTempDirSync({ dir: "/tmp", prefix: "deltic-fs-node-" }) },
  });
  const types = imports["wasi:filesystem/types@0.2"] as {
    filesystemErrorCode(err: unknown): string | undefined;
  };
  assertEq(types.filesystemErrorCode(new FsIoError("no-entry", "gone")), "no-entry");
  assertEq(types.filesystemErrorCode(new Error("random")), undefined);
});
