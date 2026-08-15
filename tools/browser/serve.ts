// Static server for the browser conformance lane.
//
// Serves, all from local disk (no CDN, no remote imports anywhere in this
// lane):
//   /                        harness/browser/index.html
//   /dist/entry.js           the bundle (built by tools/browser/bundle.ts)
//   /corpus/manifest.json    harness/generated/manifest.json
//   /corpus/<dir>/<file>     the generated JSON command files + .wasm artifacts
//   /corpus/translator_shim.wasm
//                            target/wasm32-unknown-unknown/release/…
//   /opfs.html + /fixtures/<guest>.component.wasm
//                            the OPFS smoke page and its wasip2 fixtures
//                            (examples/guests/build; tools/browser/opfs-smoke.ts)
//   POST /ingest             per-file result stream from the page
//
// `.wasm` is served as `application/wasm` so `instantiateStreaming` works if
// the runtime ever reaches for it.

import { dirname, fromFileUrl, join, normalize } from "jsr:@std/path@1";

const repoRoot = normalize(
  join(dirname(fromFileUrl(import.meta.url)), "..", ".."),
);
const browserDir = join(repoRoot, "harness", "browser");
const generatedDir = join(repoRoot, "harness", "generated");
const fixturesDir = join(repoRoot, "examples", "guests", "build");
const shimPath = join(
  repoRoot,
  "target",
  "wasm32-unknown-unknown",
  "release",
  "translator_shim.wasm",
);

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".wasm": "application/wasm",
  ".map": "application/json; charset=utf-8",
};

function mimeFor(path: string): string {
  const dot = path.lastIndexOf(".");
  return (dot >= 0 ? MIME[path.slice(dot)] : undefined) ??
    "application/octet-stream";
}

export interface IngestEvent {
  kind: "header" | "file" | "done";
  // deno-lint-ignore no-explicit-any
  header?: any;
  // deno-lint-ignore no-explicit-any
  file?: any;
}

export interface LaneServer {
  port: number;
  origin: string;
  /** Resolves when the page posts `{kind:"done"}`. */
  finished: Promise<void>;
  shutdown(): Promise<void>;
}

/** Serve a file, guarding against path traversal out of `root`. */
async function serveFile(root: string, rel: string): Promise<Response> {
  // `normalize` collapses `..`; the prefix check is the actual guard.
  const abs = normalize(join(root, rel));
  if (!abs.startsWith(root)) return new Response("forbidden", { status: 403 });
  try {
    const body = await Deno.readFile(abs);
    return new Response(body, {
      headers: {
        "content-type": mimeFor(abs),
        "cache-control": "no-store",
      },
    });
  } catch {
    return new Response(`not found: ${rel}`, { status: 404 });
  }
}

export function startServer(
  onEvent: (e: IngestEvent) => void,
): LaneServer {
  let resolveFinished!: () => void;
  const finished = new Promise<void>((r) => (resolveFinished = r));

  const server = Deno.serve({
    port: 0,
    hostname: "127.0.0.1",
    onListen() {/* quiet */},
  }, async (req) => {
    const url = new URL(req.url);
    const path = decodeURIComponent(url.pathname);

    if (req.method === "POST" && path === "/ingest") {
      const event = (await req.json()) as IngestEvent;
      onEvent(event);
      if (event.kind === "done") resolveFinished();
      return new Response("ok");
    }

    if (path === "/" || path === "/index.html") {
      return await serveFile(browserDir, "index.html");
    }
    if (path === "/opfs.html") {
      return await serveFile(browserDir, "opfs.html");
    }
    if (path.startsWith("/fixtures/")) {
      // The wasip2 guest corpus (examples/build.sh), for the OPFS smoke.
      return await serveFile(fixturesDir, path.slice("/fixtures/".length));
    }
    if (path.startsWith("/dist/")) {
      return await serveFile(
        join(browserDir, "dist"),
        path.slice("/dist/".length),
      );
    }
    if (path === "/corpus/translator_shim.wasm") {
      try {
        return new Response(await Deno.readFile(shimPath), {
          headers: {
            "content-type": "application/wasm",
            "cache-control": "no-store",
          },
        });
      } catch {
        return new Response(
          `translator shim missing at ${shimPath} — run \`cd harness && deno task shim-check\``,
          { status: 404 },
        );
      }
    }
    if (path.startsWith("/corpus/")) {
      return await serveFile(generatedDir, path.slice("/corpus/".length));
    }
    return new Response("not found", { status: 404 });
  });

  const port = (server.addr as Deno.NetAddr).port;
  return {
    port,
    origin: `http://127.0.0.1:${port}`,
    finished,
    async shutdown() {
      await server.shutdown();
    },
  };
}
