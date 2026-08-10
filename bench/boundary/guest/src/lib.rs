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
}

bindings::export!(Component with_types_in bindings);
