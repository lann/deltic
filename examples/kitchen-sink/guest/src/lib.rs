//! The guest half of the kitchen-sink example.
//!
//! Everything host-facing is in ../wit/world.wit; this file implements the
//! `api` interface (including the guest-implemented `counter` resource) and
//! drives the host-implemented `notify` imports from `run_batch`.
//!
//! Note what is ABSENT: nothing here knows that the host implements
//! `read-sensor` and `channel.send` with Promises that park this
//! component's stack (JSPI). Blocking host behavior is invisible to a
//! sync guest — that is the point of the `suspending()` embedder marker.

use std::cell::Cell;

wit_bindgen::generate!({
    path: "../wit",
    world: "kitchen-sink",
});

use exports::deltic::kitchen_sink::api::{
    Guest, GuestCounter, Level, Perms, Point, Shape,
};
use deltic::kitchen_sink::notify;

struct Component;

/// Guest-implemented resource: plain Rust state behind a handle. The host
/// sees a `Counter` class; the runtime owns the identity mapping.
struct Counter {
    value: Cell<u32>,
}

impl GuestCounter for Counter {
    fn new(start: u32) -> Self {
        Counter { value: Cell::new(start) }
    }

    fn increment(&self) -> u32 {
        self.value.set(self.value.get() + 1);
        self.value.get()
    }

    fn current(&self) -> u32 {
        self.value.get()
    }
}

impl Guest for Component {
    type Counter = Counter;

    fn describe(s: Shape) -> String {
        match s {
            Shape::Dot => "a dot".into(),
            Shape::Circle(r) => format!("a circle of radius {r}"),
            Shape::Rect(p) => format!("a rectangle to ({}, {})", p.x, p.y),
        }
    }

    fn classify(size: u32) -> Level {
        match size {
            0..=9 => Level::Debug,
            10..=99 => Level::Info,
            100..=999 => Level::Warn,
            _ => Level::Error,
        }
    }

    fn scale(p: Point, by: i32) -> Point {
        Point { x: p.x * by, y: p.y * by }
    }

    fn allowed(p: Perms) -> bool {
        // Writing requires reading; execution alone is never enough.
        p.contains(Perms::READ) && !(p == Perms::EXEC)
    }

    fn find(name: String) -> Option<Point> {
        match name.as_str() {
            "origin" => Some(Point { x: 0, y: 0 }),
            "unit" => Some(Point { x: 1, y: 1 }),
            _ => None,
        }
    }

    fn lookup(name: String) -> Result<Point, String> {
        Self::find(name.clone()).ok_or(format!("no point named '{name}'"))
    }

    fn survey() -> Vec<Option<Result<Point, String>>> {
        vec![
            None,
            Some(Ok(Point { x: 2, y: 3 })),
            Some(Err("survey hole".into())),
        ]
    }

    fn maybe_maybe(depth: u32) -> Option<Option<u32>> {
        match depth {
            0 => None,
            1 => Some(None),
            _ => Some(Some(7)),
        }
    }

    /// Drive every import: log at each level boundary, parse ids (both
    /// sides of the result), read the suspending sensor, and push
    /// `messages` strings through a channel resource.
    fn run_batch(messages: u32) -> Result<u64, String> {
        notify::log(notify::Level::Info, "batch: start");

        // Fallible import, both sides. The err side arrives as a plain
        // Result::Err here — the host threw a branded WitError.
        let id = notify::parse_id("42").map_err(|e| format!("parse-id(42): {e}"))?;
        if notify::parse_id("not a number").is_ok() {
            return Err("parse-id accepted garbage".into());
        }

        // Sync-typed call; the host parks this frame on a Promise and this
        // guest neither knows nor cares.
        let reading = notify::read_sensor();

        // Host-implemented resource: construct, method calls (send is
        // suspending on the host side), drop at end of scope (the runtime
        // calls the host class's [Symbol.dispose]).
        let chan = notify::Channel::new("batch");
        let mut sent = 0;
        for i in 0..messages {
            sent = chan.send(&format!("message {i} (id {id})"));
        }
        notify::log(
            notify::Level::Debug,
            &format!("batch: sent {sent} via '{}'", chan.label()),
        );
        if notify::Channel::open_count() == 0 {
            return Err("open-count says no channels while one is live".into());
        }

        notify::log(notify::Level::Info, "batch: done");
        Ok(reading)
    }
}

export!(Component);
