// The bench host module: echo-shaped bodies whose cost is negligible, in
// two settlement modes — "immediate" (a plain value: the send fast path)
// and "microtask" (an already-resolved promise: the wakeup-shaped path a
// real UDP receive takes).
const buffers = new Map();
function bufferOf(size) {
  let b = buffers.get(size);
  if (b === undefined) {
    b = new Uint8Array(size).fill(0x5a);
    buffers.set(size, b);
  }
  return b;
}

export function makeHost(mode) {
  if (mode === "immediate") {
    return {
      ping: (payload) => payload.length >>> 0,
      fetch: (size) => bufferOf(size),
      pingSync: (payload) => payload.length >>> 0,
    };
  }
  return {
    ping: async (payload) => payload.length >>> 0,
    fetch: async (size) => bufferOf(size),
    pingSync: (payload) => payload.length >>> 0,
  };
}
