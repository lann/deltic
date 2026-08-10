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

use wit_bindgen::rt::async_support::StreamReader;

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
}

export!(Component);
