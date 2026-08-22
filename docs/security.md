# Security posture

What this project's WASI implementation does and does not guarantee, and
what an embedder has to do itself.

Read this before granting a guest filesystem or network access.

## The headline

**The filesystem and network confinement in `@polyengine/wasi` is not a
security mechanism.** It is a correctness mechanism: it makes a guest's
requests land where the embedder said they should, and it refuses the
obvious ways of asking for something else. It is not a boundary that
holds against a guest actively trying to escape, and it is not a
substitute for an OS- or runtime-level sandbox.

If untrusted input can flow into the paths a guest opens — or if the
guest itself is untrusted — the embedder must impose its own boundary.
Recipes are at the bottom of this page.

## Why path confinement can never be a boundary

The filesystem backends confine guest paths to their preopens. The
provider layer resolves guest paths textually (`..` cannot climb past a
preopen, absolute paths and NUL are refused), and the node backend adds
physical containment on top: it resolves each path against the preopen's
real path before handing anything to the OS, and refuses what lands
outside.

That is worth having, and it closes the escapes a guest reaches for
first. It cannot be a security boundary, for reasons that have nothing to
do with how carefully it is written:

- **Hardlinks.** A hardlink inside a preopen pointing at an inode outside
  it resolves entirely "within" the tree. No amount of path checking sees
  this, because by every path-shaped measure it *is* inside.
- **Bind mounts and mount points.** Same shape: the path stays inside the
  preopen, the bytes are somewhere else entirely.
- **Cross-process races.** Between the moment the implementation resolves
  a path and the moment the OS acts on it, another process can swap a
  component for a symlink. Closing this requires anchoring every
  operation to a file descriptor (`openat`-style), which `node:fs` does
  not expose.
- **It rests on the backend's own resolution logic.** Symlink resolution
  is subtle, and platform behavior is not uniform: this project has found
  cases where the same code confines correctly under one set of runtime
  permission flags and not another (see the `PLATFORM TRAPS` note in
  `wasi/src/filesystem_node.ts`). Every such quirk is a bug we can fix;
  the class of such quirks is not one we can close by being careful.

The web backend (OPFS) is different in kind: it has no host namespace to
escape and no symlinks, so containment there is structural rather than
checked. The browser's origin sandbox is the boundary.

## What the implementation gives you

**Preopens are explicit grants.** There is no default and no ambient
filesystem. A guest sees exactly the directories the embedder named:

```ts
filesystemNode({ preopens: { "/": "./sandbox" } })
```

**Read-only by default.** Write access is opt-in for the whole
filesystem implementation:

```ts
filesystemNode({ preopens: { "/": "./data" }, writable: true })
```

Without `writable`, every mutating operation is refused with the WIT
`read-only` error code — writes, creation, truncation, deletion,
rename, link and symlink creation, and timestamp changes. This is
deliberately a single package-level flag rather than a per-preopen
permission. Per-preopen permissions form a lattice, and the
two-descriptor operations (`link-at`, `rename-at`) are edges between
cells: each is a place where the check can attach to the wrong
descriptor, letting a guest bridge from a read-only preopen to a
writable one. wasmtime-wasi had a vulnerability of that shape. One flag
has no lattice to bridge, and the proof obligation becomes a closed
enumeration — every mutating operation refuses — which is checkable
against the WIT.

**Outgoing HTTP requests can be scoped by name.** `http()` takes an
`allowRequest` policy, evaluated on the assembled request before anything
is dispatched:

```ts
http({
  allowRequest: ({ url, method }) =>
    url.protocol === "https:" && url.hostname.endsWith(".example.com") &&
    method === "GET",
})
```

`true` (the default) is unscoped egress; `false` denies everything while
leaving the types and resources usable; a callback may be async. A
callback that throws denies — a predicate that fails must not fail open.
Refusals reach the guest as the WIT `HTTP-request-denied` error code, and
a refused request never drains the guest's body stream. Because the
implementation does not follow redirects, each hop is a fresh request and
is checked again — unless an embedder supplies its own transport via
`http({ fetch })` and re-enables redirect following, which is trusted
code and can undo this.

This is a name-level check only, which is the whole of what a
`fetch`-based host can express. See "What it does not give you" below for
what that leaves open.

**Capabilities are à la carte.** The `wasi()` batteries merge carries
only ambient, side-effect-benign capabilities. Everything that grants
real host authority is a separate, deliberate import: `filesystem-node`,
`filesystem-web`, `sockets`, `http`, `cli-stdio`.

## What it does not give you

- **No network scoping** for `sockets()`, which grants the host's
  network reach wholesale: no allowlist, no address check, no TCP/UDP
  toggle. A guest with `sockets()` can talk to anything this process can
  reach, including loopback services and cloud instance metadata
  endpoints. Tracked by
  [#200](https://github.com/polymorph-components/polyengine/issues/200).
- **No address-level check for `http()` either.** `allowRequest` sees the
  URL a guest asked for, not the address it resolves to, so it cannot
  refuse a name that resolves to loopback, a link-local address or a
  cloud metadata endpoint — and the resolution can change between the
  check and the connection. Closing that requires resolving and
  connecting ourselves rather than delegating to `fetch`, which is not
  possible in a browser at all: name resolution and connection happen
  inside the network stack, and JS never observes an address.
- **No stdio scoping.** `cliStdio()` grants the host process's stdin,
  stdout, stderr, environment and arguments.
- **No protection against a hostile guest reaching outside a preopen**
  by the means listed above.

## Imposing a real boundary

These are the mechanisms that actually hold, in rough order of how much
they cost you. All of them are the embedder's or the operator's job:
nothing in this package can apply them on your behalf, and a library that
refused to start without them would only push the decision into your
source code, where it would travel to production disguised as a
deliberate choice.

**Scoped runtime permissions.** The cheapest real boundary, and it lives
in the deployment rather than the code:

```sh
# Deno
deno run --allow-read=/srv/sandbox --allow-write=/srv/sandbox app.ts

# Node
node --permission --allow-fs-read=/srv/sandbox --allow-fs-write=/srv/sandbox app.js
```

Both restrict the whole process, so the host application is bound by the
same limits as the guest. Note that Node's permission model has no
stable network dimension, so it constrains the filesystem grants above
but not `sockets()` or `http()`.

**Landlock** (Linux 5.13+) restricts a process to a set of paths with
specified access rights, enforced by the kernel against resolved inodes
— so it is not fooled by symlinks, hardlinks or bind mounts. It is
unprivileged and irreversible once applied, which makes it a good fit
for a server process that takes its grants at startup.

**Containers, seccomp, VMs.** The conventional answer when the guest is
genuinely untrusted, and the only one that also contains the host
application.

**Give the guest no host namespace at all.** If the component does not
need live host files, back its filesystem with something you fully own —
an in-memory tree or an image file. Containment stops being a property
you check and becomes one that cannot be expressed otherwise. This is
what the OPFS backend gets for free.

## The artifact cache is a trust input

The artifact cache (`@polyengine/runtime`'s `runtime/src/cache/`, see
[architecture.md §10](architecture.md)) stores a translated plan and its
adapter modules so a reload can skip the translator. It is host-side: it
never passes through the WASI filesystem, and no guest can reach it
through any interface this package exposes. But it stores its entries in
the same host namespace a guest's preopens are carved out of, and **a
cache entry is worth roughly what the component binary is worth.**

The plan drives module slicing, adapter selection, import wiring and
initializers. What the runtime verifies on a cache hit is real but
narrower than it looks:

- the stored entry agrees with the requested key, and the plan's recorded
  component hash matches it;
- the plan is structurally valid (`loadPlan`);
- the caller's component bytes hash to `plan.component.sha256`
  (`verifyComponent`);
- with generated typed bindings, the world digest matches the one the
  bindings were built from.

What nothing verifies is that the plan is *the plan the translator would
have produced for those bytes*. The world digest is computed from the
plan itself, so it catches skew and coarse substitution, not tampering.
Write access to the cache root therefore buys about what write access to
your component files buys.

**Keep the cache root outside every preopen tree.** Not a child, not a
sibling you also preopen, not a parent. And note that scoped runtime
permissions cannot enforce this for you: one process needs write access
to the cache root, so at that layer the cache and a writable preopen are
indistinguishable. What separates them is the WASI provider's own path
handling — which the top of this page says is not a boundary. The
read-only default is what makes the common case safe: a guest that cannot
write anywhere cannot poison a cache.

**The stronger recipe: a pre-warmed, read-only cache.** Translate at
build time, ship the cache directory as an artifact, and run with no
write access to it:

```sh
# build step (writes the cache)
deno run --allow-read --allow-write=/srv/cache warm.ts

# production (cannot write the cache at all)
deno run --allow-read=/srv/app,/srv/cache --allow-write=/srv/state app.ts
```

Cache hits work normally without write access. A miss, a stale entry
after a layout-version bump, or an unreadable root degrades to a fresh
translation rather than an error — no cache failure fails a translation.
Pass `onCacheError` to `translateCached` if you want the degradation to
be visible in your logs. This is the only arrangement that keeps a
compromise of the running process from becoming a persistent one.

**Use `dirCache` on servers, not `webCache`.** Deno's Cache API needs no
permission flag, so it cannot be scoped or denied, and — absent
`--location` — it stores in a user-global bucket shared by every Deno
program that user runs, any of which can overwrite entries under the same
cache name. It also does not exist on Node or Bun. `webCache` is the
browser backend, where it is the only option, there is no permission
model to leverage, and the platform partitions storage by origin.

## Reporting

Security issues in this project should be reported through the
repository's issue tracker, or privately to the maintainers if the report
would itself be a working escape.
