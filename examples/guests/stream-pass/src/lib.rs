//! `stream-pass` guest: passes streams through WITHOUT ever reading them.
//!
//! The point (issue #54 investigation): a `stream` value is an identity, not
//! a buffer — a guest that receives a readable end and hands it straight back
//! (result position) or straight on (import position) should never touch the
//! payload, so none of these exports read a single element.

wit_bindgen::generate!({
    world: "stream-pass",
    async: true,
});

use wit_bindgen::rt::async_support::{FutureReader, StreamReader};

struct Component;

impl Guest for Component {
    async fn pass_through(input: StreamReader<u8>) -> StreamReader<u8> {
        input
    }

    async fn forward(input: StreamReader<u8>) -> u64 {
        sink(input).await
    }

    async fn pass_through_text(input: StreamReader<String>) -> StreamReader<String> {
        input
    }

    async fn take(mut input: StreamReader<u8>, count: u32) -> u64 {
        let mut sum = 0u64;
        for _ in 0..count {
            match input.next().await {
                Some(b) => sum += u64::from(b),
                None => break,
            }
        }
        sum
        // `input` drops here with the remainder unread: the host's parked
        // write settles short ("reader went away"), cleanly.
    }

    async fn consume_then_trap(mut input: StreamReader<u8>, count: u32) {
        for _ in 0..count {
            let _ = input.next().await;
        }
        core::arch::wasm32::unreachable()
    }

    async fn open_then_trap(n: u32) -> StreamReader<u8> {
        let (mut writer, reader) = wit_stream::new();
        wit_bindgen::rt::async_support::spawn_local(async move {
            let _ = writer.write(vec![7u8; n as usize]).await;
            core::arch::wasm32::unreachable()
        });
        reader
    }

    async fn future_then_trap(mut gate: StreamReader<u8>) -> FutureReader<u32> {
        let (writer, reader) = wit_future::new(|| 0u32);
        wit_bindgen::rt::async_support::spawn_local(async move {
            // Park until the host releases the gate — giving it time to park
            // a read on the future — then trap without ever writing.
            let _ = gate.next().await;
            let _hold = writer;
            core::arch::wasm32::unreachable()
        });
        reader
    }
}

export!(Component);
