---
title: "Zero-copy connection handoff in Rust with io_uring and SCM_RIGHTS"
description: "How catraca accepts TCP connections with io_uring AcceptMulti and hands the raw file descriptor to local workers, without ever reading a byte."
pubDate: 2026-06-25
lang: "en-us"
tags: ["rust", "io_uring", "systems"]
---

**catraca** is a single-host TCP dispatcher in Rust. The name is Portuguese for turnstile: it controls who passes and where they go. It accepts TCP connections, picks a local worker round-robin, and hands the connection off. The interesting part is that it never reads a single request byte. The kernel passes the open socket directly to the worker.

## Not a reverse proxy

It helps to say what catraca is not. It is an L4 connection dispatcher, not an L7 reverse proxy. It cannot route by path, header or hostname, because it never parses the request. There is no TLS, no HTTP, no health checks, no retries, no metrics. By design.

What you get instead is roughly 300 lines, two dependencies (`libc` and `io-uring`), no async runtime, and no allocator pressure on the hot path. It is a different category of tool from NGINX or Envoy, useful in exactly one situation: workers on the same host that you want to feed with minimum latency overhead.

## The accept side: io_uring AcceptMulti

The listener runs on a single thread with a single io_uring instance. Instead of submitting one accept per connection, catraca submits one multishot accept (`AcceptMulti`, `IORING_OP_ACCEPT` in multishot mode, available since Linux 5.19). One submission queue entry then produces a completion for every incoming connection, with no resubmission. `SO_REUSEPORT` is set on the listener, so multiple catraca instances could share the port for a NUMA-aware fanout.

## The handoff: SCM_RIGHTS over a Unix socket

This is the core trick. A file descriptor is just an index into a per-process table, so you cannot send it to another process by writing its number. But Unix domain sockets let you pass an actual descriptor through an ancillary message of type `SCM_RIGHTS`. The kernel installs a new descriptor in the receiving process that points at the same open file, here the client's TCP socket.

catraca connects to each worker's control socket (the worker's UDS path with `.ctrl` appended) and, for each accepted connection, sends one byte plus one control message carrying the client fd. The receiving worker takes ownership and serves the request end to end. No bytes are copied between the connection and the worker.

The worker side of the contract is a single `recvmsg`:

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
// client_fd is yours
```

## One choice worth explaining

It would be natural to submit the handoff `sendmsg` through io_uring too, to keep everything on the ring. catraca does not. The handoff is a synchronous `sendmsg` syscall on the accept thread, on purpose: for a one-byte payload plus a single control message, the cost of submitting the operation through io_uring is larger than just making the syscall. The round-robin index is a plain wrapping `usize` with no synchronization, because there is only one thread. Less machinery, less latency.

## Running it

```sh
cargo build --release

PORT=9999 \
UPSTREAMS=/run/api1.sock,/run/api2.sock \
./target/release/catraca
```

`UPSTREAMS` is the list of worker UDS base paths; catraca derives each control socket by appending `.ctrl`. It needs Linux 5.19+ and `io_uring` not blocked by seccomp.

catraca is alpha, and it has been used in production for a benchmark workload, not yet hardened against adversarial traffic. If you are writing your own workers and can implement the `SCM_RIGHTS` receive contract, it is a very small, very fast way to spread connections across them. The code is on [GitHub](https://github.com/maracatu-org/catraca).
