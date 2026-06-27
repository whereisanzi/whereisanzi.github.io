---
title: "Zero-copy connection handoff in Rust with io_uring and SCM_RIGHTS"
description: "A close reading of catraca: how it accepts TCP with io_uring multishot accept and hands the raw client fd to local workers via SCM_RIGHTS, never reading a byte."
pubDate: 2026-06-25
lang: "en-us"
tags: ["rust", "io_uring", "systems"]
---

**catraca** is a single-host L4 TCP connection dispatcher written in Rust. The name is Portuguese for turnstile, which is a good description of what it does: it stands at the door, lets each connection through, and points it at a worker. It accepts TCP connections with io_uring multishot accept, picks a local worker round-robin, and hands the raw client file descriptor to that worker over a Unix socket. The part worth writing about is that it never reads a single request byte. The kernel passes the open socket directly into another process, and that process serves the request end to end.

I spent an afternoon reading the source (crate version 0.2.1, MIT licensed) and this is what I found, including the places where the README and the code disagree. Where they disagree, I trust the code.

## What it is, and what it is not

It helps to set the boundary first. catraca is an L4 connection dispatcher, not an L7 reverse proxy. It cannot route by path, header, or hostname in its normal path, because it never parses the request. There is no TLS, no HTTP parsing on the hot path, no metrics, no config file. It is a different category of tool from NGINX or Envoy, useful in exactly one situation: workers on the same host that you want to feed with the minimum possible latency overhead.

What you get instead is a very small program. Almost all of the logic lives in a single file, `src/proxy.rs`, which is 455 lines. With `main.rs` (13 lines) and `lib.rs` (5 lines), the whole thing is 473 lines of source. The README says around 300 lines, but that is not accurate; call it under 500. The `lib.rs` file gates the entire implementation behind `cfg(target_os = "linux")`, and on any other platform `main` prints an error and exits.

The dependency list is just as lean. `Cargo.toml` pins edition 2021 and `rust-version` 1.83, with two direct dependencies: `libc` 0.2 (unconditional) and `io-uring` 0.7 (gated to Linux). The lockfile resolves to four crates total, since `bitflags` and `cfg-if` come along transitively. The release profile is aggressive in a way worth noting: `opt-level = 3`, `lto = "fat"`, `codegen-units = 1`, `strip = true`, `panic = "abort"`, and `overflow-checks = false`. This is a binary tuned to be small and fast, with no unwinding machinery.

## Why a file descriptor cannot be sent by number

The whole design rests on one fact about Unix. A file descriptor is just a small integer index into a per-process table. The number 7 in catraca and the number 7 in a worker point at completely different things. So you cannot hand a connection to another process by writing "7" down a pipe. The receiving process would look up 7 in its own table and find something unrelated, or nothing.

Unix domain sockets solve this with ancillary data. You send a normal message, but you attach a control message of type `SCM_RIGHTS` carrying one or more descriptor numbers. The kernel intercepts that control message, looks up the descriptors in the sending process, and installs fresh descriptors in the receiving process that point at the same underlying open files. The numbers will differ on each side; the open file is shared. That is how catraca moves a live TCP socket from itself into a worker without the connection ever noticing.

## The accept side: io_uring multishot accept

The listener runs on a single thread driving a single io_uring instance. The ring queue depth, `RING_QD`, is 4096, and the ring is built like this:

```rust
let mut ring = IoUring::builder()
    .setup_single_issuer()
    .setup_coop_taskrun()
    .build(RING_QD)?;
```

Both setup flags are deliberate. `setup_single_issuer` (the `IORING_SETUP_SINGLE_ISSUER` flag) promises the kernel that only one thread will ever touch the submission queue, which lets the kernel skip some synchronization. `setup_coop_taskrun` asks the kernel to batch the task-work it runs on completion instead of firing an inter-processor interrupt for each one, which lowers overhead on a busy ring. Both are a natural fit for a single-threaded event loop.

There is an honesty point here. The README says Linux 5.19+, which is when multishot accept landed. But `setup_single_issuer` requires Linux 6.0 or newer. The code uses it unconditionally, so the real floor for this binary is Linux 6.0, not 5.19.

Instead of submitting one accept per connection, catraca submits a single multishot accept and lets the kernel keep producing completions from it:

```rust
fn push_accept(sq: &mut SubmissionQueue, listen_fd: RawFd) {
    let accept = opcode::AcceptMulti::new(types::Fd(listen_fd))
        .build()
        .user_data(pack_user_data(OP_ACCEPT));
    unsafe {
        let _ = sq.push(&accept);
    }
}
```

The `user_data` packs an opcode tag into the top 8 bits. With a single opcode, `OP_ACCEPT`, this is more machinery than the program needs today, which reads to me like a design that expected to grow more operation types later.

The event loop pushes one accept before it starts, then settles into a simple rhythm:

```rust
push_accept(&mut ring.submission(), listen_fd);
loop {
    ring.submit_and_wait(1)?;
    cqes.clear();
    for cqe in ring.completion() {
        cqes.push(cqe);
    }
    for cqe in &cqes {
        handle_accept(cqe, /* ... */);
    }
}
```

Copying completions out of `ring.completion()` into a reused `Vec` before processing them is not an accident. It releases the borrow on the ring, so `handle_accept` is free to push new submission queue entries while it runs. The `Vec` is pre-sized and reused, so there is no per-iteration allocation.

The multishot re-arm is the subtle bit. A multishot accept stays armed as long as the kernel sets the `CQE_F_MORE` flag on its completions. catraca only re-submits the accept when that flag clears:

```rust
fn handle_accept(cqe: &cqueue::Entry, /* ... */) {
    if cqe.flags() & cqueue::flags::MORE == 0 {
        push_accept(/* ... */);
    }
    // ... handle this connection ...
}
```

So in steady state there is exactly one accept SQE doing all the work. Accept errors arrive as negative completion results, and catraca simply drops that connection after re-arming. There is no special handling for `EINTR` or `EAGAIN`, because io_uring delivers those conditions as ordinary completion results rather than as syscall return codes.

## The handoff: a synchronous sendmsg

Here is the heart of it. Once catraca has an accepted client fd, it sends that fd to a worker. You might expect the `sendmsg` to go through io_uring too, to keep everything on the ring. It does not. The handoff is a plain synchronous `libc::sendmsg` on the accept thread. The rationale from the design notes is direct: for a one-byte payload plus a single control message, the cost of submitting the operation through io_uring is larger than just making the syscall. So it makes the syscall.

```rust
unsafe fn send_fd_to(ctrl: RawFd, fd: RawFd) -> isize {
    let cmsg_space = libc::CMSG_SPACE(mem::size_of::<libc::c_int>() as u32) as usize;
    let mut cmsg_buf: [u8; 32] = [0u8; 32];
    let mut dummy: u8 = 0;
    let mut iov = libc::iovec { iov_base: &mut dummy as *mut _ as *mut libc::c_void, iov_len: 1 };
    let mut msg: libc::msghdr = mem::zeroed();
    msg.msg_iov = &mut iov;
    msg.msg_iovlen = 1;
    msg.msg_control = cmsg_buf.as_mut_ptr() as *mut libc::c_void;
    msg.msg_controllen = cmsg_space as _;
    let cmsg = libc::CMSG_FIRSTHDR(&msg);
    (*cmsg).cmsg_level = libc::SOL_SOCKET;
    (*cmsg).cmsg_type = libc::SCM_RIGHTS;
    (*cmsg).cmsg_len = libc::CMSG_LEN(mem::size_of::<libc::c_int>() as u32) as _;
    ptr::write_unaligned(libc::CMSG_DATA(cmsg) as *mut libc::c_int, fd);
    libc::sendmsg(ctrl, &msg, 0)
}
```

A few details that matter. The control buffer is a fixed `[u8; 32]` stack array, not a heap allocation. The data payload is a single dummy byte, because `SCM_RIGHTS` requires at least one byte of regular data to ride along. The control message is `SOL_SOCKET` / `SCM_RIGHTS`, and the fd is written into `CMSG_DATA` with `ptr::write_unaligned` to avoid any alignment assumption. The `sendmsg` flags are 0.

After the handoff, whether it succeeded or failed, catraca always closes its own copy of the client fd. The worker now holds its own descriptor for the same socket, so catraca's copy is just a reference it no longer needs.

The worker side of this contract is a single `recvmsg`. The worker binds `<path>.ctrl`, accepts the control connection from catraca, and receives the fd:

```c
char dummy;
struct iovec iov = { &dummy, 1 };
char cmsg_buf[CMSG_SPACE(sizeof(int))];
struct msghdr msg = {0};
msg.msg_iov = &iov;
msg.msg_iovlen = 1;
msg.msg_control = cmsg_buf;
msg.msg_controllen = sizeof(cmsg_buf);

ssize_t n = recvmsg(ctrl_fd, &msg, 0);
struct cmsghdr *c = CMSG_FIRSTHDR(&msg);
int client_fd;
memcpy(&client_fd, CMSG_DATA(c), sizeof(int));
// client_fd is yours now: serve the connection
```

No request bytes are copied between the connection and the worker. The connection is the worker's from this point on.

## Listener tuning

The listener is built by hand in `create_listener`, which is more interesting than a `TcpListener` would be. It opens `socket(AF_INET, SOCK_STREAM | SOCK_CLOEXEC)`, sets `SO_REUSEADDR` and then `SO_REUSEPORT`, binds `0.0.0.0:PORT`, and calls `listen` with the configured backlog. It deliberately does not set the socket nonblocking, because io_uring handles readiness for it.

Two tuning choices stand out. First, it sets `TCP_DEFER_ACCEPT = 1`, which the README does not mention. With this set, the kernel does not surface the accept until the client has actually sent data, so catraca never wakes up for a connection that has nothing to say yet. Second, every accepted client fd gets `TCP_NODELAY` set before the handoff, so the worker inherits a socket without Nagle delays.

`SO_REUSEPORT` is there for a reason that is not currently wired up: several catraca instances could share the same port, which would let you run one per NUMA node for a locality-aware fanout. That is prose in the design, not an exposed feature yet.

## Control sockets, lifecycle, and round-robin

Each upstream is represented with a `ctrl_fd` stored as an `AtomicI32` that starts at -1, meaning not connected. At startup catraca spawns one thread per upstream, named `ctrl-connect-{i}`, to connect to that upstream's `<path>.ctrl` without blocking the listener. The connector, `connect_ctrl_retry`, loops forever, sleeping 50ms between attempts until it succeeds.

This is where I want to correct a common phrasing, including my own earlier draft. catraca is often described as "single-threaded", and the hot path genuinely is a single-threaded event loop. But the process briefly runs N+1 threads at startup: the main accept loop plus one connector per upstream. Once the connectors succeed they are done. It is fair to call the data path single-threaded; it is not fair to say the process only ever has one thread.

On the hot path, sending a fd goes through `try_send_fd_with_reconnect`. It loads `ctrl_fd` with `Acquire` ordering. If the `sendmsg` fails with a recoverable errno (`EPIPE`, `ECONNRESET`, `EBADF`, or `ENOTCONN`), it closes the broken fd, stores -1, and reconnects, up to 3 tries spaced 50ms apart, looping at most twice before it gives up and drops the connection. So there is real reconnect logic here, not a fire-and-forget send.

Round-robin selection is as plain as it gets. There is one `let mut rr: usize = 0` in the single-threaded loop, and selection is:

```rust
let idx = rr % upstreams.len();
rr = rr.wrapping_add(1);
```

No atomics, no locks, because there is only one thread choosing.

A word on `unsafe`: there is a lot of it, and all of it is for libc FFI and the io-uring submission queue push. None of it is doing anything exotic for performance. SIGPIPE is set to `SIG_IGN` at startup, which is why a worker disappearing turns into an `EPIPE` return value catraca can handle rather than a signal that kills the process.

## What the README oversimplifies

Reading the code against the README turned up a few honest gaps, and I think they are worth stating plainly.

The line count is wrong: it is about 450 lines of real logic, not 300. The kernel floor is wrong: `setup_single_issuer` pushes it to Linux 6.0+, not 5.19+. And the biggest one: the README frames catraca as having "no health checks, no retries, by design", but the code has both. The reconnect logic above is the retry story. And there is an optional, undocumented health endpoint.

If you set `HEALTH_PATH` (a fourth environment variable, beyond `PORT`, `BACKLOG`, and `UPSTREAMS`), catraca does an `MSG_PEEK` of up to 64 bytes on a freshly accepted connection. If those bytes start with `GET <path>`, catraca replies `HTTP/1.1 200 OK` itself and closes the connection. That request never reaches a worker. This is genuine L7 behavior living inside a tool that bills itself as pure L4. It is a small, pragmatic concession, and it is off by default, so the default path really is pure L4. But it exists, and pretending otherwise would be dishonest.

One more honesty note: there are no tests, no benchmarks, and no CI in the repo. The only "benchmark" is the README line that it has been used in production for a benchmark workload. So I will not quote any latency numbers, because there are none to quote.

## Running it

```sh
cargo build --release

PORT=9999 \
UPSTREAMS=/run/api1.sock,/run/api2.sock \
./target/release/catraca
```

`UPSTREAMS` is required and is the list of worker UDS base paths; catraca derives each control socket by appending `.ctrl`. It needs Linux 6.0+ and `io_uring` not blocked by seccomp.

If you write your own workers and can implement the `SCM_RIGHTS` receive contract, catraca is a very small, very fast way to spread connections across them, with the connection handed off by the kernel rather than proxied byte by byte. Read the source yourself, it is short and rewarding: [github.com/maracatu-org/catraca](https://github.com/maracatu-org/catraca).
