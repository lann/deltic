//! `values` guest: echoes every WIT type shape back to the caller.
//!
//! Intentionally trivial — the point is exercising the canonical ABI
//! lift/lower paths on the host side, not guest logic.

wit_bindgen::generate!({
    world: "values",
});

struct Component;

impl Guest for Component {
    fn echo_bool(v: bool) -> bool {
        v
    }
    fn echo_u64(v: u64) -> u64 {
        v
    }
    fn echo_s64(v: i64) -> i64 {
        v
    }
    fn echo_f32(v: f32) -> f32 {
        v
    }
    fn echo_f64(v: f64) -> f64 {
        v
    }
    fn echo_char(v: char) -> char {
        v
    }
    fn echo_string(v: String) -> String {
        v
    }
    fn echo_record(v: Mixed) -> Mixed {
        v
    }
    fn echo_variant(v: Shape) -> Shape {
        v
    }
    fn echo_enum(v: Color) -> Color {
        v
    }
    fn echo_flags(v: Perms) -> Perms {
        v
    }
    fn echo_option(v: Option<String>) -> Option<String> {
        v
    }
    fn echo_option_nested(v: Option<Option<u32>>) -> Option<Option<u32>> {
        v
    }
    fn echo_result(v: Result<u32, String>) -> Result<u32, String> {
        v
    }
    fn echo_list_u8(v: Vec<u8>) -> Vec<u8> {
        v
    }
    fn echo_list_string(v: Vec<String>) -> Vec<String> {
        v
    }
    fn echo_tuple(v: (u32, String, f64)) -> (u32, String, f64) {
        v
    }
}

export!(Component);
