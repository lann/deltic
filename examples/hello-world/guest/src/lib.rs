//! The guest half of the hello-world example: implement the `hello`
//! world's one export. `wit_bindgen::generate!` reads ../wit/world.wit and
//! emits the `Guest` trait; `export!` wires the implementation into the
//! component's export table.

wit_bindgen::generate!({
    path: "../wit",
    world: "hello",
});

struct Component;

impl Guest for Component {
    fn greet(name: String) -> String {
        format!("Hello, {name}!")
    }
}

export!(Component);
