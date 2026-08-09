// WebRTC-under-Deno capability probe (docs/consumers.md (C0 evidence)).
//
// Question answered: can Deno functionally substitute for Node as the
// consumers' JS-native lane, on the one capability that is not a Deno
// built-in — WebRTC? The polymorph webrtc host module resolves
// `RTCPeerConnection` isomorphically (globalThis, else
// `node-datachannel/polyfill`), so this probes both candidate providers
// with a full data-channel loopback: offer/answer, trickled ICE
// (buffered until remote descriptions are set — libdatachannel emits
// candidates immediately on setLocalDescription), SCTP channel open,
// and a bidirectional message echo.
//
// Legs:
//   1. node-datachannel/polyfill — the exact dependency the polymorph
//      Node legs use; a Node-API native addon (prebuilt binaries via the
//      now-unmaintained prebuild-install; hence leg 2).
//   2. werift — pure-TS WebRTC; the no-native-code fallback.
//
// Run (from this directory):
//   deno install --allow-scripts=npm:node-datachannel
//   deno run --allow-all probe.mjs
//
// First verified: 2026-08-08, Deno 2.9.5, linux-arm64 — both legs PASS.

const timeout = (ms) =>
  new Promise((_, rej) => setTimeout(() => rej(new Error(`timeout ${ms}ms`)), ms));

async function loopback(RTCPeerConnection, label) {
  const a = new RTCPeerConnection();
  const b = new RTCPeerConnection();
  // Buffer trickled candidates until the peer has its remote description.
  const pend = { a: [], b: [] };
  a.onicecandidate = (e) =>
    e.candidate && (pend.b ? pend.b.push(e.candidate) : b.addIceCandidate(e.candidate));
  b.onicecandidate = (e) =>
    e.candidate && (pend.a ? pend.a.push(e.candidate) : a.addIceCandidate(e.candidate));

  const chA = a.createDataChannel("probe");
  const echoed = new Promise((resolve, reject) => {
    b.ondatachannel = ({ channel }) => {
      channel.onmessage = (e) => channel.send(`echo:${e.data}`);
      channel.onerror = reject;
    };
    chA.onmessage = (e) => resolve(e.data);
    chA.onerror = reject;
    chA.onopen = () => chA.send("hello");
  });

  const offer = await a.createOffer();
  await a.setLocalDescription(offer);
  await b.setRemoteDescription(offer);
  for (const c of pend.b) await b.addIceCandidate(c);
  pend.b = null;
  const answer = await b.createAnswer();
  await b.setLocalDescription(answer);
  await a.setRemoteDescription(answer);
  for (const c of pend.a) await a.addIceCandidate(c);
  pend.a = null;

  const result = await Promise.race([echoed, timeout(15000)]);
  if (result !== "echo:hello") throw new Error(`unexpected echo: ${JSON.stringify(result)}`);
  console.log(`PASS ${label}: data channel echo => ${JSON.stringify(result)}`);
  chA.close();
  a.close();
  b.close();
}

let failures = 0;

try {
  const { RTCPeerConnection } = await import("node-datachannel/polyfill");
  console.log("node-datachannel/polyfill loaded (Node-API addon works under Deno)");
  await loopback(RTCPeerConnection, "node-datachannel");
  (await import("node-datachannel")).cleanup?.();
} catch (err) {
  failures++;
  console.log(`FAIL node-datachannel: ${err?.message}\n  cause: ${err?.cause?.message ?? "-"}`);
}

try {
  const { RTCPeerConnection } = await import("werift");
  console.log("werift loaded (pure TS)");
  await loopback(RTCPeerConnection, "werift");
} catch (err) {
  failures++;
  console.log(`FAIL werift: ${err?.message}\n  cause: ${err?.cause?.message ?? "-"}`);
}

// node-datachannel keeps background threads alive; exit explicitly.
Deno.exit(failures);
