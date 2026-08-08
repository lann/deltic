//! `future-user` guest: awaits an imported future value and produces/
//! resolves an exported one.

wit_bindgen::generate!({
    world: "future-user",
    async: true,
});

use wit_bindgen::rt::async_support::FutureReader;

struct Component;

impl Guest for Component {
    async fn double_future(f: FutureReader<u32>) -> u32 {
        f.await * 2
    }

    async fn make_future(x: u32) -> FutureReader<u32> {
        let (writer, reader) = wit_future::new(|| 0u32);
        // `write` is a rendezvous: it only completes once the *other* side
        // (the host, once it has the reader) receives the value, so it must
        // not be awaited here — that would deadlock before `reader` is ever
        // handed back. Spawn it in the background instead.
        wit_bindgen::rt::async_support::spawn_local(async move {
            wit_bindgen::yield_async().await;
            let _ = writer.write(x + 1).await;
        });
        reader
    }
}

export!(Component);
