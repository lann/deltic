//! `async-probe` guest: Component Model 0.3 async ABI exerciser.
//!
//! All exports are generated as async lifts (callback ABI). The guest-side
//! executor lives in wit-bindgen's runtime; `yield_async` forces at least
//! one genuine suspension so hosts must actually implement task resumption.

wit_bindgen::generate!({
    world: "async-probe",
    // Redundant with the `async` annotations in the WIT, but explicit:
    // generate every export with the async ABI.
    async: true,
});

use wit_bindgen::rt::async_support::{FutureReader, StreamReader};

struct Component;

impl Guest for Component {
    async fn wait_then_double(x: u32) -> u32 {
        // Canonical `yield` builtin: suspends this task and asks the host
        // scheduler to resume it later.
        wit_bindgen::yield_async().await;
        x * 2
    }

    async fn sum_stream(mut values: StreamReader<u32>) -> u64 {
        let mut sum: u64 = 0;
        while let Some(v) = values.next().await {
            sum += u64::from(v);
        }
        sum
    }

    async fn future_add(f: FutureReader<u32>, y: u32) -> u32 {
        f.await + y
    }
}

export!(Component);
