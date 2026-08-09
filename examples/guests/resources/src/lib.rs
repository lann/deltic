//! `resources` guest: a counter resource with observable destructors.
//!
//! `LIVE` tracks the number of live `MyCounter` instances so the host can
//! assert that destructors actually ran (`live-counters` export).

use std::cell::Cell;
use std::sync::atomic::{AtomicU32, Ordering};

wit_bindgen::generate!({
    world: "resources",
});

use exports::deltic::resources::counters::{
    Counter, CounterBorrow, Guest, GuestCounter,
};

static LIVE: AtomicU32 = AtomicU32::new(0);

struct MyCounter {
    value: Cell<u64>,
}

impl MyCounter {
    fn make(initial: u64) -> MyCounter {
        LIVE.fetch_add(1, Ordering::Relaxed);
        MyCounter {
            value: Cell::new(initial),
        }
    }
}

impl Drop for MyCounter {
    fn drop(&mut self) {
        LIVE.fetch_sub(1, Ordering::Relaxed);
    }
}

impl GuestCounter for MyCounter {
    fn new(initial: u64) -> MyCounter {
        MyCounter::make(initial)
    }

    fn increment(&self) -> u64 {
        let v = self.value.get() + 1;
        self.value.set(v);
        v
    }

    fn get(&self) -> u64 {
        self.value.get()
    }

    fn merge(a: Counter, b: Counter) -> Counter {
        let sum = a.get::<MyCounter>().value.get() + b.get::<MyCounter>().value.get();
        // `a` and `b` are owned: dropping them here runs their destructors.
        drop(a);
        drop(b);
        Counter::new(MyCounter::make(sum))
    }
}

struct Component;

impl Guest for Component {
    type Counter = MyCounter;

    fn make_counter(initial: u64) -> Counter {
        Counter::new(MyCounter::make(initial))
    }

    fn sum_both(a: CounterBorrow<'_>, b: CounterBorrow<'_>) -> u64 {
        a.get::<MyCounter>().value.get() + b.get::<MyCounter>().value.get()
    }

    fn bump(c: CounterBorrow<'_>, by: u64) -> u64 {
        let inner = c.get::<MyCounter>();
        let v = inner.value.get() + by;
        inner.value.set(v);
        v
    }

    fn consume(c: Counter) -> u64 {
        let v = c.get::<MyCounter>().value.get();
        drop(c); // destructor runs here, inside the guest
        v
    }

    fn live_counters() -> u32 {
        LIVE.load(Ordering::Relaxed)
    }
}

export!(Component);
