//! `yield-only` guest: pure callback-ABI exerciser.
//!
//! Isolates the suspend/resume protocol (canonical `yield` builtin) from
//! everything else in the async surface (context slots, backpressure,
//! streams/futures) — see `context-user`/`backpressure-probe`/`stream-echo`/
//! `future-user` for those.

wit_bindgen::generate!({
    world: "yield-only",
    async: true,
});

struct Component;

impl Guest for Component {
    async fn yield_n_times(count: u32) -> u32 {
        for _ in 0..count {
            wit_bindgen::yield_async().await;
        }
        count
    }
}

export!(Component);
