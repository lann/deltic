//! The boundary microbench guest: tight loops over the host imports so
//! the host can time calls-per-second for each boundary shape.

mod bindings {
    wit_bindgen::generate!({
        path: "wit",
        world: "bench",
        generate_all,
    });
}

use bindings::bench::boundary::host;
use wit_bindgen::rt::async_support::{spawn_local, StreamReader};

struct Component;

impl bindings::Guest for Component {
    async fn send(iters: u32, size: u32) -> u64 {
        let payload = vec![0xa5u8; size as usize];
        let mut acc = 0u64;
        for _ in 0..iters {
            acc = acc.wrapping_add(host::ping(payload.clone()).await as u64);
        }
        acc
    }

    async fn recv(iters: u32, size: u32) -> u64 {
        let mut acc = 0u64;
        for _ in 0..iters {
            let got = host::fetch(size).await;
            acc = acc.wrapping_add(got.len() as u64);
        }
        acc
    }

    async fn send_sync(iters: u32, size: u32) -> u64 {
        let payload = vec![0xa5u8; size as usize];
        let mut acc = 0u64;
        for _ in 0..iters {
            acc = acc.wrapping_add(host::ping_sync(&payload) as u64);
        }
        acc
    }

    // Stream-shaped lanes (issue #68): drain / pump / pass-through, no
    // host import involved — the host drives the stream endpoint
    // directly (see driver-polyengine.mjs).

    async fn stream_sink(s: StreamReader<u8>) -> u64 {
        s.collect().await.len() as u64
    }

    async fn stream_source(n: u32) -> StreamReader<u8> {
        let (mut writer, reader) = bindings::wit_stream::new();
        spawn_local(async move {
            let payload = vec![0x5au8; n as usize];
            writer.write_all(payload).await;
            // `writer` drops here, closing the stream.
        });
        reader
    }

    async fn stream_pass(s: StreamReader<u8>) -> StreamReader<u8> {
        s
    }
}

bindings::export!(Component with_types_in bindings);
