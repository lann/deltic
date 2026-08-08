//! `backpressure-probe` guest: toggles `backpressure.inc`/`backpressure.dec`
//! around a genuine suspension point.

wit_bindgen::generate!({
    world: "backpressure-probe",
    async: true,
});

struct Component;

impl Guest for Component {
    async fn toggle_around_yield(x: u32) -> u32 {
        wit_bindgen::backpressure_inc();
        wit_bindgen::yield_async().await;
        wit_bindgen::backpressure_dec();
        x
    }
}

export!(Component);
