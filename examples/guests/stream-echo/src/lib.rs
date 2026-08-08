//! `stream-echo` guest: consumes AND produces a `stream<u32>` in one export.
//!
//! Demand-side inventory note (examples/README.md): validates whether
//! wit-bindgen 0.60's generated `wit_stream::new()` producer half is usable
//! from a stable-Rust guest with no extra feature flags beyond `async-spawn`
//! (needed only for the background-forwarding pattern, not for streams
//! themselves).

wit_bindgen::generate!({
    world: "stream-echo",
    async: true,
});

use wit_bindgen::rt::async_support::{StreamReader, StreamResult};

struct Component;

impl Guest for Component {
    async fn echo_doubled(mut input: StreamReader<u32>) -> StreamReader<u32> {
        let (mut writer, reader) = wit_stream::new();
        wit_bindgen::rt::async_support::spawn_local(async move {
            while let Some(v) = input.next().await {
                let doubled = v.wrapping_mul(2);
                let (result, _buf) = writer.write(vec![doubled]).await;
                if !matches!(result, StreamResult::Complete(_)) {
                    break;
                }
            }
            // `writer` drops here, closing the output stream once `input`
            // is exhausted (or the reader side went away).
        });
        reader
    }
}

export!(Component);
