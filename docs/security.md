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

**Capabilities are à la carte.** The `wasi()` batteries merge carries
only ambient, side-effect-benign capabilities. Everything that grants
real host authority is a separate, deliberate import: `filesystem-node`,
`filesystem-web`, `sockets`, `http`, `cli-stdio`.

## What it does not give you

- **No network scoping.** `sockets()` and `http()` grant the host's
  network reach wholesale. There is no allowlist, no address check, and
  no TCP/UDP toggle. A guest with `sockets()` can talk to anything this
  process can reach, including loopback services and cloud instance
  metadata endpoints.
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

## Reporting

Security issues in this project should be reported through the
repository's issue tracker, or privately to the maintainers if the report
would itself be a working escape.
