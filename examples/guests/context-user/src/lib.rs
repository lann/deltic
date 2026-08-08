//! `context-user` guest: context-local-storage (slot 0) exerciser via
//! interleaved concurrent task activations.

wit_bindgen::generate!({
    world: "context-user",
    async: true,
});

use std::cell::RefCell;
use std::rc::Rc;

struct Component;

impl Guest for Component {
    async fn interleave(count: u32) -> u32 {
        let total = Rc::new(RefCell::new(0u32));
        let done = Rc::new(RefCell::new(0u32));

        for i in 0..count {
            let total = total.clone();
            let done = done.clone();
            wit_bindgen::rt::async_support::spawn_local(async move {
                // Yield `i` times: each spawned task suspends and resumes a
                // different number of times, so the callback ABI must keep
                // each activation's context-local state distinct while they
                // interleave on the single event loop.
                for _ in 0..i {
                    wit_bindgen::yield_async().await;
                }
                *total.borrow_mut() += i;
                *done.borrow_mut() += 1;
            });
        }

        // Busy-wait (yielding) until every spawned task has recorded its
        // contribution. Single-threaded cooperative scheduling: no lock
        // needed, only cooperative suspension via `yield_async`.
        while *done.borrow() < count {
            wit_bindgen::yield_async().await;
        }

        let result = *total.borrow();
        result
    }
}export!(Component);
