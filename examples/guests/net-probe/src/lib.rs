//! `net-probe` guest: a std::net battery entirely inside the guest —
//! a TCP listener + client self-echo over loopback, then a UDP socket
//! pair round-trip. Built for wasm32-wasip2, so every operation travels
//! std::net -> wasi-libc -> `wasi:sockets@0.2` two-phase ops (start/finish
//! bind/connect/listen, accept), `wasi:io@0.2` socket streams
//! (blocking-read / blocking-write-and-flush), and pollable blocking —
//! the real linkage of a ported networking program, end to end against
//! the host provider under test.

wit_bindgen::generate!({
    world: "net-probe",
});

use std::io::{ErrorKind, Read, Write};
use std::net::{TcpListener, TcpStream, UdpSocket};

struct Component;

fn step<T, E: std::fmt::Display>(what: &str, r: Result<T, E>) -> Result<T, String> {
    r.map_err(|e| format!("{what}: {e}"))
}

fn check(what: &str, cond: bool) -> Result<(), String> {
    if cond { Ok(()) } else { Err(format!("{what}: check failed")) }
}

impl Guest for Component {
    fn run() -> Result<String, String> {
        // --- TCP: bind an ephemeral listener, dial it, echo both ways ------
        let listener = step("tcp bind", TcpListener::bind("127.0.0.1:0"))?;
        let addr = step("tcp local_addr", listener.local_addr())?;
        check("tcp ephemeral port", addr.port() != 0)?;

        let mut client = step("tcp connect", TcpStream::connect(addr))?;
        let (mut served, peer) = step("tcp accept", listener.accept())?;
        check("tcp peer is loopback", peer.ip().is_loopback())?;

        step("tcp client write", client.write_all(b"ping from the client"))?;
        step("tcp client FIN", client.shutdown(std::net::Shutdown::Write))?;
        let mut inbound = String::new();
        step("tcp served read", served.read_to_string(&mut inbound))?;
        check("tcp inbound", inbound == "ping from the client")?;

        step("tcp served write", served.write_all(b"pong from the server"))?;
        step("tcp served FIN", served.shutdown(std::net::Shutdown::Write))?;
        let mut echoed = String::new();
        step("tcp client read", client.read_to_string(&mut echoed))?;
        check("tcp echoed", echoed == "pong from the server")?;
        drop(client);
        drop(served);
        drop(listener);

        // --- UDP: a bound pair, both directions -----------------------------
        let a = step("udp bind a", UdpSocket::bind("127.0.0.1:0"))?;
        let b = step("udp bind b", UdpSocket::bind("127.0.0.1:0"))?;
        let b_addr = step("udp b local_addr", b.local_addr())?;
        step("udp send a->b", a.send_to(b"datagram!", b_addr))?;
        let mut buf = [0u8; 64];
        let (n, from) = step("udp recv at b", b.recv_from(&mut buf))?;
        check("udp payload", &buf[..n] == b"datagram!")?;
        check(
            "udp source",
            from == step("udp a local_addr", a.local_addr())?,
        )?;
        step("udp send b->a (connected)", {
            b.connect(from).and_then(|()| b.send(b"reply"))
        })?;
        let (n, _) = step("udp recv at a", a.recv_from(&mut buf))?;
        check("udp reply", &buf[..n] == b"reply")?;

        // --- the error path: a dial to a closed port must fail cleanly ------
        drop(b);
        match TcpStream::connect(("127.0.0.1", 1)) {
            Err(e) if e.kind() == ErrorKind::ConnectionRefused => {}
            other => return Err(format!("expected ConnectionRefused, got {other:?}")),
        }

        Ok("net probe ok".to_string())
    }
}

export!(Component);
