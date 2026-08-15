// `@deltic/wasi/filesystem-node` — `wasi:filesystem@0.2` + `@0.3` over the
// node `node:fs` builtin (via `process.getBuiltinModule`: real Node and
// Deno's stable node compat alike — the node-builtins-everywhere stance of
// sockets_platform.ts). It grants HOST FILESYSTEM access, so it never
// rides the default `wasi()` merge; preopens are explicit grants:
//
//   instantiate(a, { ...wasi(), ...filesystemNode({ preopens: { "/": "./sandbox" } }).imports })
//
// SYNC BY CONSTRUCTION: every backend op uses node's `*Sync` API, so the
// 0.2 track's sync WIT functions are served without parking — guests run
// in plain callback mode, no JSPI required (the A14 marks stay off; see
// fs_provider.ts). The 0.3 track returns plain values from async funcs,
// which the runtime accepts.
//
// SECURITY (fs_provider.ts module header): guest paths are confined
// TEXTUALLY to the preopen root ("`..`" cannot escape), but symlink
// TARGETS are followed by the OS without per-component containment
// checks (node has no openat2/RESOLVE_BENEATH). A symlink inside the
// preopen pointing outside it will be followed. Do not preopen trees
// containing untrusted symlinks.
//
// Fidelity notes: `append` stats-then-writes (not O_APPEND atomic);
// set-times converts to seconds-resolution node utimes (ns precision is
// reported by stat but not settable); `..` resolves textually, not
// physically through symlinked intermediates.

import {
  type DescriptorType,
  type FilesystemFragment,
  type FsBackend,
  type FsErrorCode,
  type FsIdentity,
  type FsStat,
  makeFilesystem,
  type MaybeAsync,
  type Opened,
  type OpenOptions,
  type TimeSpec,
} from "./fs_provider.ts";

// --- the node:fs surface we consume (structural, no @types dependency) ------------

interface NodeBigIntStats {
  isDirectory(): boolean;
  isFile(): boolean;
  isSymbolicLink(): boolean;
  isBlockDevice(): boolean;
  isCharacterDevice(): boolean;
  isFIFO(): boolean;
  isSocket(): boolean;
  nlink: bigint;
  size: bigint;
  atimeNs: bigint;
  mtimeNs: bigint;
  ctimeNs: bigint;
  dev: bigint;
  ino: bigint;
}

interface NodeDirent {
  name: string;
  isDirectory(): boolean;
  isFile(): boolean;
  isSymbolicLink(): boolean;
  isBlockDevice(): boolean;
  isCharacterDevice(): boolean;
  isFIFO(): boolean;
  isSocket(): boolean;
}

interface NodeFsModule {
  constants: {
    O_RDONLY: number;
    O_WRONLY: number;
    O_RDWR: number;
    O_CREAT: number;
    O_EXCL: number;
    O_TRUNC: number;
    O_NOFOLLOW: number;
    O_DIRECTORY: number;
  };
  openSync(path: string, flags: number): number;
  closeSync(fd: number): void;
  readSync(fd: number, buffer: Uint8Array, offset: number, length: number, position: number): number;
  writeSync(fd: number, buffer: Uint8Array, offset: number, length: number, position: number): number;
  fstatSync(fd: number, opts: { bigint: true }): NodeBigIntStats;
  statSync(path: string, opts: { bigint: true }): NodeBigIntStats;
  lstatSync(path: string, opts: { bigint: true }): NodeBigIntStats;
  readdirSync(path: string, opts: { withFileTypes: true }): NodeDirent[];
  mkdirSync(path: string): void;
  rmdirSync(path: string): void;
  unlinkSync(path: string): void;
  renameSync(oldPath: string, newPath: string): void;
  linkSync(existingPath: string, newPath: string): void;
  symlinkSync(target: string, path: string): void;
  readlinkSync(path: string): string;
  ftruncateSync(fd: number, len: number): void;
  truncateSync(path: string, len: number): void;
  fsyncSync(fd: number): void;
  fdatasyncSync(fd: number): void;
  futimesSync(fd: number, atime: number, mtime: number): void;
  utimesSync(path: string, atime: number, mtime: number): void;
  lutimesSync(path: string, atime: number, mtime: number): void;
  realpathSync(path: string): string;
}

/** `process.getBuiltinModule(name)`, if this host has it (Node, Deno, Bun). */
function nodeBuiltin(name: string): unknown {
  const proc = (globalThis as {
    process?: { getBuiltinModule?: (name: string) => unknown };
  }).process;
  const get = proc?.getBuiltinModule;
  return get === undefined ? undefined : get.call(proc, name);
}

// --- errno mapping ---------------------------------------------------------------

const ERRNO_MAP: Record<string, FsErrorCode> = {
  EACCES: "access",
  EPERM: "not-permitted",
  ENOENT: "no-entry",
  EEXIST: "exist",
  ENOTDIR: "not-directory",
  EISDIR: "is-directory",
  ENOTEMPTY: "not-empty",
  EINVAL: "invalid",
  ELOOP: "loop",
  EXDEV: "cross-device",
  ENAMETOOLONG: "name-too-long",
  EBUSY: "busy",
  EROFS: "read-only",
  EBADF: "bad-descriptor",
  EFBIG: "file-too-large",
  ENOSPC: "insufficient-space",
  EDQUOT: "quota",
  EMLINK: "too-many-links",
  ESPIPE: "invalid-seek",
  ENXIO: "no-such-device",
  ENODEV: "no-device",
  ETXTBSY: "text-file-busy",
  EOVERFLOW: "overflow",
  EINTR: "interrupted",
  EAGAIN: "would-block",
  ENOMEM: "insufficient-memory",
  ENOTSUP: "unsupported",
  EOPNOTSUPP: "unsupported",
  EILSEQ: "illegal-byte-sequence",
};

// --- the backend -----------------------------------------------------------------

/** A descriptor handle: dirs are path-only; files carry the open fd. */
interface NodeHandle {
  path: string;
  type: DescriptorType;
  fd?: number;
}

function direntType(d: {
  isDirectory(): boolean;
  isFile(): boolean;
  isSymbolicLink(): boolean;
  isBlockDevice(): boolean;
  isCharacterDevice(): boolean;
  isFIFO(): boolean;
  isSocket(): boolean;
}): DescriptorType {
  if (d.isDirectory()) return "directory";
  if (d.isFile()) return "regular-file";
  if (d.isSymbolicLink()) return "symbolic-link";
  if (d.isBlockDevice()) return "block-device";
  if (d.isCharacterDevice()) return "character-device";
  if (d.isFIFO()) return "fifo";
  if (d.isSocket()) return "socket";
  return "unknown";
}

function makeNodeBackend(fs: NodeFsModule): FsBackend<NodeHandle> {
  const join = (base: NodeHandle, segments: string[]): string =>
    segments.length === 0 ? base.path : `${base.path}/${segments.join("/")}`;

  const requireFd = (h: NodeHandle): number => {
    if (h.fd === undefined) {
      // Directory handles carry no fd; byte ops on one are EISDIR.
      throw Object.assign(new Error("descriptor is a directory"), { code: "EISDIR" });
    }
    return h.fd;
  };

  const statOf = (st: NodeBigIntStats): FsStat => ({
    type: direntType(st),
    linkCount: st.nlink,
    size: st.size,
    atimeNs: st.atimeNs,
    mtimeNs: st.mtimeNs,
    ctimeNs: st.ctimeNs,
  });

  const statHandle = (h: NodeHandle): NodeBigIntStats =>
    h.fd === undefined ? fs.statSync(h.path, { bigint: true }) : fs.fstatSync(h.fd, { bigint: true });

  /** node utimes take seconds (fractional); "no-change" re-applies the
   * current value (POSIX UTIME_OMIT has no node spelling). */
  const timeArgs = (
    current: () => NodeBigIntStats,
    atime: TimeSpec,
    mtime: TimeSpec,
  ): [number, number] => {
    const now = Date.now() / 1000;
    const secs = (spec: TimeSpec, currentNs: () => bigint): number => {
      switch (spec.kind) {
        case "no-change":
          return Number(currentNs()) / 1e9;
        case "now":
          return now;
        case "timestamp":
          return Number(spec.ns) / 1e9;
      }
    };
    let st: NodeBigIntStats | undefined;
    const cached = (): NodeBigIntStats => (st ??= current());
    return [
      secs(atime, () => cached().atimeNs),
      secs(mtime, () => cached().mtimeNs),
    ];
  };

  return {
    isSync: true,

    mapError(e: unknown): FsErrorCode {
      const code = (e as { code?: unknown })?.code;
      return (typeof code === "string" ? ERRNO_MAP[code] : undefined) ?? "io";
    },

    openAt(base, segments, opts): Opened<NodeHandle> {
      const full = join(base, segments);
      const c = fs.constants;
      let flags = opts.write ? (opts.read ? c.O_RDWR : c.O_WRONLY) : c.O_RDONLY;
      if (opts.create) flags |= c.O_CREAT;
      if (opts.exclusive) flags |= c.O_EXCL;
      if (opts.truncate) flags |= c.O_TRUNC;
      if (!opts.follow) flags |= c.O_NOFOLLOW;
      if (opts.directory) flags |= c.O_DIRECTORY;
      // Directories: path handles (no fd — every dir op is path-based).
      const st = (opts.follow ? fs.statSync : fs.lstatSync).bind(fs);
      let existing: NodeBigIntStats | undefined;
      try {
        existing = st(full, { bigint: true });
      } catch {
        existing = undefined; // may be about to be created
      }
      if (existing?.isDirectory()) {
        if (opts.exclusive && opts.create) {
          throw Object.assign(new Error("exists"), { code: "EEXIST" });
        }
        return { handle: { path: full, type: "directory" }, type: "directory" };
      }
      if (opts.directory && existing !== undefined) {
        throw Object.assign(new Error("not a directory"), { code: "ENOTDIR" });
      }
      const fd = fs.openSync(full, flags);
      const opened = fs.fstatSync(fd, { bigint: true });
      const type = direntType(opened);
      if (type === "directory") {
        // Raced into a directory: fall back to a path handle.
        fs.closeSync(fd);
        return { handle: { path: full, type }, type };
      }
      return { handle: { path: full, type, fd }, type };
    },

    close(h): void {
      if (h.fd !== undefined) fs.closeSync(h.fd);
    },

    stat: (h): FsStat => statOf(statHandle(h)),

    statAt(base, segments, follow): FsStat {
      const st = (follow ? fs.statSync : fs.lstatSync).bind(fs);
      return statOf(st(join(base, segments), { bigint: true }));
    },

    read(h, length, offset): Uint8Array {
      const out = new Uint8Array(length);
      const n = fs.readSync(requireFd(h), out, 0, length, offset);
      return out.subarray(0, n);
    },

    write(h, buffer, offset): number {
      return fs.writeSync(requireFd(h), buffer, 0, buffer.length, offset);
    },

    append(h, buffer): number {
      const fd = requireFd(h);
      const size = Number(fs.fstatSync(fd, { bigint: true }).size);
      return fs.writeSync(fd, buffer, 0, buffer.length, size);
    },

    setSize(h, size): void {
      if (h.fd === undefined) fs.truncateSync(h.path, size);
      else fs.ftruncateSync(h.fd, size);
    },

    setTimes(h, atime, mtime): void {
      const [a, m] = timeArgs(() => statHandle(h), atime, mtime);
      if (h.fd === undefined) fs.utimesSync(h.path, a, m);
      else fs.futimesSync(h.fd, a, m);
    },

    setTimesAt(base, segments, follow, atime, mtime): void {
      const full = join(base, segments);
      const st = (follow ? fs.statSync : fs.lstatSync).bind(fs);
      const [a, m] = timeArgs(() => st(full, { bigint: true }), atime, mtime);
      (follow ? fs.utimesSync : fs.lutimesSync).call(fs, full, a, m);
    },

    syncAll(h): void {
      if (h.fd !== undefined) fs.fsyncSync(h.fd);
    },

    syncData(h): void {
      if (h.fd !== undefined) fs.fdatasyncSync(h.fd);
    },

    readDirectory(h): { name: string; type: DescriptorType }[] {
      return fs.readdirSync(h.path, { withFileTypes: true }).map((d) => ({
        name: d.name,
        type: direntType(d),
      }));
    },

    createDirectoryAt(base, segments): void {
      fs.mkdirSync(join(base, segments));
    },

    removeDirectoryAt(base, segments): void {
      fs.rmdirSync(join(base, segments));
    },

    unlinkFileAt(base, segments): void {
      fs.unlinkSync(join(base, segments));
    },

    renameAt(oldBase, oldSegments, newBase, newSegments): void {
      fs.renameSync(join(oldBase, oldSegments), join(newBase, newSegments));
    },

    linkAt(oldBase, oldSegments, _follow, newBase, newSegments): void {
      fs.linkSync(join(oldBase, oldSegments), join(newBase, newSegments));
    },

    symlinkAt(target, base, segments): void {
      fs.symlinkSync(target, join(base, segments));
    },

    readlinkAt(base, segments): string {
      return fs.readlinkSync(join(base, segments));
    },

    identity(h): FsIdentity {
      const st = statHandle(h);
      return { a: st.dev, b: st.ino };
    },

    identityAt(base, segments, follow): FsIdentity {
      const st = (follow ? fs.statSync : fs.lstatSync).bind(fs);
      const s = st(join(base, segments), { bigint: true });
      return { a: s.dev, b: s.ino };
    },

    isSame(a, b): boolean {
      const sa = statHandle(a);
      const sb = statHandle(b);
      return sa.dev === sb.dev && sa.ino === sb.ino;
    },
  };
}

// --- the fragment ----------------------------------------------------------------

export interface FilesystemNodeOptions {
  /**
   * Guest name → host directory path. Each entry becomes a preopen
   * (`preopens#get-directories`). No default: filesystem access is an
   * explicit grant. Host paths are resolved (realpath) at construction
   * and must name directories.
   */
  preopens: Record<string, string>;
}

/**
 * `wasi:filesystem` over node's `node:fs` builtin (module header).
 * Serves both the `@0.2` and `@0.3` tracks.
 */
export function filesystemNode(options: FilesystemNodeOptions): FilesystemFragment {
  const fs = nodeBuiltin("node:fs") as NodeFsModule | undefined;
  if (fs === undefined) {
    throw new TypeError(
      "filesystemNode: no `process.getBuiltinModule` on this host — " +
        "node:fs is required (real Node, or Deno's stable node compat); " +
        "browsers want @deltic/wasi/filesystem-web",
    );
  }
  const preopens: [NodeHandle, string][] = Object.entries(options.preopens).map(
    ([guestName, hostPath]) => {
      const real = fs.realpathSync(hostPath);
      if (!fs.statSync(real, { bigint: true }).isDirectory()) {
        throw new TypeError(`filesystemNode: preopen ${hostPath} is not a directory`);
      }
      return [{ path: real, type: "directory" }, guestName];
    },
  );
  return makeFilesystem(makeNodeBackend(fs), preopens);
}

// Re-exported for tests and typed embedders.
export type { FilesystemFragment, MaybeAsync };
