# bench/boundary — the host-boundary microbench

Calls-per-second across the host import boundary, per ABI shape — the
instrument behind [#17](https://github.com/lann/deltic/issues/17)'s
jco-vs-deltic baseline, [#54](https://github.com/lann/deltic/issues/54)'s
lift-throughput finding, and [#8](https://github.com/lann/deltic/issues/8)'s
cost ledger. The design goal is attribution, not realism: the guest is a
tight loop over echo-shaped imports whose host bodies are trivial, so
what the clock sees is lift/lower + dispatch + (for async shapes) the
suspension machinery — and both stacks run on **the same engine** (plain
`node` runs the deltic callback ABI with no flag; the jco lane and
deltic's jspi mode share `--experimental-wasm-jspi`), so V8/GC/JIT
variables cancel.

```sh
just bench-boundary            # deltic lanes: node callback+jspi, deno
just bench-boundary with-jco   # + the incumbent jco lane (npm ci + transpile on first use)
```

The deltic lanes measure the CURRENT TREE: the recipe builds the local
embedder bundle (`tools/release-bundle/build.ts`) and the local
translator shim. Numbers are box-relative — compare lanes within one
run, or the same lane across commits on one box, never absolute values
across machines.

## Shapes

| export | import it loops | boundary shape |
| --- | --- | --- |
| `send` | `ping: async func(list<u8>) -> u32` | UDP-send-shaped: payload guest→host |
| `recv` | `fetch: async func(u32) -> list<u8>` | UDP-receive-shaped: payload host→guest |
| `send-sync` | `ping-sync: func(list<u8>) -> u32` | the sync-lowered control |

Host settlement `mode`: `immediate` (a plain return value — the fast
path) and `microtask` (an async host fn, i.e. an already-resolved
promise — the wakeup-shaped path a real receive takes). Payload sizes 0
(pure call overhead) and 1200 B (QUIC-ish MTU). Medians of 5 timed
export calls after a warmup call; each export call runs `iters`
boundary crossings.

## Baseline (2026-08-10, linux-arm64 dev box, Node 24.18 / Deno 2.9.5, guest wit-bindgen 0.60)

```
shape     mode       size    deltic-node-callback      deltic-node-jspi  deltic-deno-callback         jco-node-jspi
send      immediate  0                1,079,807/s           1,016,348/s           1,168,392/s                 336/s
send      immediate  1200               680,210/s             637,144/s             722,588/s                 336/s
send      microtask  0                  541,613/s             250,349/s             526,868/s                 338/s
send      microtask  1200               396,974/s             223,360/s             399,989/s                 339/s
recv      immediate  0                1,182,824/s           1,111,585/s           1,381,300/s                 345/s
recv      immediate  1200                18,546/s              18,213/s              21,706/s                 375/s
recv      microtask  0                  550,893/s             300,230/s             604,611/s                 338/s
recv      microtask  1200                18,160/s              17,364/s              20,366/s                 490/s
send-sync immediate  0                1,604,379/s           1,057,590/s           1,440,209/s             338,332/s
send-sync immediate  1200               759,075/s             591,627/s             922,990/s             300,576/s
send-sync microtask  0                1,545,879/s           1,234,868/s           1,359,083/s             337,477/s
send-sync microtask  1200               629,432/s             623,742/s             826,725/s             310,692/s
```

What the baseline says:

- **Async import round-trips**: deltic's callback ABI sustains 0.4–1.2 M
  crossings/s; jco's async path costs ~3 ms per call flat
  (timer-quantized — its sync path is healthy at ~300 k/s, so the cost
  is the async task loop, the same machinery behind lann/jco#11 and
  polymorph-iroh's 5 ms polling workaround). For the UDP direct path
  (#4) this is the difference between "boundary is free" and "boundary
  is the bottleneck".
- **#54**: host→guest `list<u8>` lift runs ~45 ns/byte (~22 MB/s
  ceiling, flat across sizes — a per-element copy), while guest→host
  lower is bulk (~6.4 GB/s at 16 KiB). The `recv @ 1200` rows are the
  regression sentinel for the fix.
- **jspi vs callback** (same runtime, same engine): parity on
  immediate-settled paths, ~2× behind on deferred (microtask) paths —
  the suspend/resume cost, recorded for #8.

The jco lane pins the family's own toolchain (the lann/jco all-fixes
transpile + preview2-shim release tarballs, the vendored
`jco-transpile.mjs` wrapper, and polymorph-test's `bindImports` for the
WASI spellings — the exact stack the consumer repos' jco legs run). It
exists as the incumbent baseline and retires with the jco era.
