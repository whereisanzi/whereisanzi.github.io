---
title: "Handoff de conexão zero-copy em Rust com io_uring e SCM_RIGHTS"
description: "Uma leitura atenta do catraca: como ele aceita TCP com multishot accept do io_uring e entrega o fd cru do cliente para workers locais via SCM_RIGHTS, sem ler um byte."
pubDate: 2026-06-25
lang: "pt-br"
tags: ["rust", "io_uring", "sistemas"]
---

**catraca** é um dispatcher de conexão TCP L4 single-host escrito em Rust. O nome descreve bem o que ele faz: fica na porta, deixa cada conexão passar e aponta para um worker. Ele aceita conexões TCP com multishot accept do io_uring, escolhe um worker local em round-robin e entrega o file descriptor cru do cliente para esse worker por um socket Unix. A parte que vale escrever sobre é que ele nunca lê um único byte da requisição. O kernel passa o socket aberto direto para outro processo, e esse processo atende a requisição de ponta a ponta.

Passei uma tarde lendo o código (versão 0.2.1 da crate, licença MIT) e é isso que encontrei, incluindo os pontos onde o README e o código discordam. Onde discordam, eu confio no código.

## O que ele é, e o que ele não é

Ajuda definir o limite primeiro. O catraca é um dispatcher de conexão L4, não um reverse proxy L7. Ele não consegue rotear por path, header ou hostname no caminho normal, porque nunca faz parsing da requisição. Não tem TLS, não tem parsing de HTTP no hot path, não tem métrica, não tem arquivo de config. É uma categoria de ferramenta diferente de NGINX ou Envoy, útil em exatamente uma situação: workers no mesmo host que você quer alimentar com o mínimo possível de overhead de latência.

O que você ganha em troca é um programa muito pequeno. Quase toda a lógica vive em um único arquivo, `src/proxy.rs`, com 455 linhas. Com o `main.rs` (13 linhas) e o `lib.rs` (5 linhas), o projeto inteiro tem 473 linhas de código. O README fala em torno de 300 linhas, mas isso não confere; diga menos de 500. O `lib.rs` tranca a implementação inteira atrás de `cfg(target_os = "linux")`, e em qualquer outra plataforma o `main` imprime um erro e sai.

A lista de dependências é igualmente enxuta. O `Cargo.toml` fixa edition 2021 e `rust-version` 1.83, com duas dependências diretas: `libc` 0.2 (incondicional) e `io-uring` 0.7 (restrita ao Linux). O lockfile resolve em quatro crates no total, já que `bitflags` e `cfg-if` entram transitivamente. O perfil de release é agressivo de um jeito que vale notar: `opt-level = 3`, `lto = "fat"`, `codegen-units = 1`, `strip = true`, `panic = "abort"` e `overflow-checks = false`. É um binário afinado para ser pequeno e rápido, sem maquinário de unwinding.

## Por que um file descriptor não pode ser enviado pelo número

Todo o design se apoia em um fato do Unix. Um file descriptor é só um inteiro pequeno que indexa uma tabela por processo. O número 7 no catraca e o número 7 num worker apontam para coisas completamente diferentes. Então você não pode entregar uma conexão a outro processo escrevendo "7" num pipe. O processo que recebe procuraria o 7 na própria tabela e acharia algo sem relação, ou nada.

Sockets de domínio Unix resolvem isso com dados auxiliares (ancillary data). Você envia uma mensagem normal, mas anexa uma mensagem de controle do tipo `SCM_RIGHTS` carregando um ou mais números de descriptor. O kernel intercepta essa mensagem de controle, procura os descriptors no processo que envia e instala descriptors novos no processo que recebe, apontando para os mesmos arquivos abertos. Os números vão diferir nos dois lados; o arquivo aberto é compartilhado. É assim que o catraca move um socket TCP vivo de si mesmo para um worker sem que a conexão perceba nada.

## O lado do accept: multishot accept do io_uring

O listener roda em uma única thread tocando uma única instância de io_uring. A profundidade da fila do ring, `RING_QD`, é 4096, e o ring é construído assim:

```rust
let mut ring = IoUring::builder()
    .setup_single_issuer()
    .setup_coop_taskrun()
    .build(RING_QD)?;
```

As duas flags de setup são deliberadas. `setup_single_issuer` (a flag `IORING_SETUP_SINGLE_ISSUER`) promete ao kernel que só uma thread vai tocar a submission queue, o que permite ao kernel pular alguma sincronização. `setup_coop_taskrun` pede ao kernel para agrupar o task-work que ele roda nas completions em vez de disparar uma interrupção entre processadores para cada uma, o que reduz overhead num ring movimentado. As duas combinam naturalmente com um event loop single-threaded.

Tem um ponto de honestidade aqui. O README diz Linux 5.19+, que é quando o multishot accept entrou. Mas `setup_single_issuer` exige Linux 6.0 ou mais novo. O código usa essa flag sem condição, então o piso real para este binário é Linux 6.0, não 5.19.

Em vez de submeter um accept por conexão, o catraca submete um único accept multishot e deixa o kernel ir produzindo completions a partir dele:

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

O `user_data` empacota uma tag de opcode nos 8 bits do topo. Com um único opcode, `OP_ACCEPT`, isso é mais maquinário do que o programa precisa hoje, o que para mim soa como um design que esperava crescer com mais tipos de operação depois.

O event loop empurra um accept antes de começar, e então assume um ritmo simples:

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

Copiar as completions de `ring.completion()` para um `Vec` reaproveitado antes de processá-las não é acidente. Isso libera o borrow no ring, então o `handle_accept` fica livre para empurrar novas entradas na submission queue enquanto roda. O `Vec` é pré-dimensionado e reutilizado, então não há alocação por iteração.

O re-arm do multishot é a parte sutil. Um accept multishot continua armado enquanto o kernel marca a flag `CQE_F_MORE` nas suas completions. O catraca só resubmete o accept quando essa flag zera:

```rust
fn handle_accept(cqe: &cqueue::Entry, /* ... */) {
    if cqe.flags() & cqueue::flags::MORE == 0 {
        push_accept(/* ... */);
    }
    // ... trata esta conexão ...
}
```

Então em regime estável existe exatamente um SQE de accept fazendo todo o trabalho. Erros de accept chegam como resultados negativos de completion, e o catraca simplesmente descarta aquela conexão depois de re-armar. Não há tratamento especial para `EINTR` ou `EAGAIN`, porque o io_uring entrega essas condições como resultados de completion comuns, e não como códigos de retorno de syscall.

## O handoff: um sendmsg síncrono

Aqui está o coração da coisa. Quando o catraca tem um fd de cliente aceito, ele envia esse fd para um worker. Você poderia esperar que o `sendmsg` também fosse pelo io_uring, para manter tudo no ring. Não é. O handoff é um `libc::sendmsg` síncrono comum na thread de accept. A justificativa das notas de design é direta: para um payload de um byte mais uma única mensagem de controle, o custo de submeter a operação pelo io_uring é maior que simplesmente fazer o syscall. Então ele faz o syscall.

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

Alguns detalhes que importam. O buffer de controle é um array de pilha fixo `[u8; 32]`, não uma alocação no heap. O payload de dados é um único byte dummy, porque o `SCM_RIGHTS` exige pelo menos um byte de dados normais junto. A mensagem de controle é `SOL_SOCKET` / `SCM_RIGHTS`, e o fd é escrito em `CMSG_DATA` com `ptr::write_unaligned` para não assumir nenhum alinhamento. As flags do `sendmsg` são 0.

Depois do handoff, com sucesso ou falha, o catraca sempre fecha a própria cópia do fd do cliente. O worker agora tem o próprio descriptor para o mesmo socket, então a cópia do catraca é só uma referência que ele não precisa mais.

O lado do worker nesse contrato é um único `recvmsg`. O worker faz bind em `<path>.ctrl`, aceita a conexão de controle vinda do catraca e recebe o fd:

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
// client_fd é seu agora: atenda a conexão
```

Nenhum byte da requisição é copiado entre a conexão e o worker. A conexão é do worker daqui em diante.

## Afinação do listener

O listener é construído na mão em `create_listener`, o que é mais interessante do que um `TcpListener` seria. Ele abre `socket(AF_INET, SOCK_STREAM | SOCK_CLOEXEC)`, seta `SO_REUSEADDR` e depois `SO_REUSEPORT`, faz bind em `0.0.0.0:PORT` e chama `listen` com o backlog configurado. De propósito ele não coloca o socket em modo nonblocking, porque o io_uring cuida da prontidão por ele.

Duas escolhas de afinação se destacam. Primeiro, ele seta `TCP_DEFER_ACCEPT = 1`, que o README não menciona. Com isso, o kernel não expõe o accept até o cliente realmente ter enviado dados, então o catraca nunca acorda por uma conexão que ainda não tem nada a dizer. Segundo, todo fd de cliente aceito recebe `TCP_NODELAY` antes do handoff, então o worker herda um socket sem os atrasos do Nagle.

O `SO_REUSEPORT` está ali por um motivo que ainda não está ligado: várias instâncias do catraca poderiam compartilhar a mesma porta, o que permitiria rodar uma por nó NUMA para um fanout consciente de localidade. Isso é prosa no design, não um recurso exposto ainda.

## Sockets de controle, ciclo de vida e round-robin

Cada upstream é representado com um `ctrl_fd` guardado como um `AtomicI32` que começa em -1, significando não conectado. Na inicialização, o catraca spawna uma thread por upstream, nomeada `ctrl-connect-{i}`, para conectar ao `<path>.ctrl` daquele upstream sem bloquear o listener. O conector, `connect_ctrl_retry`, repete para sempre, dormindo 50ms entre tentativas até ter sucesso.

É aqui que quero corrigir uma frase comum, inclusive do meu rascunho anterior. O catraca é descrito muitas vezes como "single-threaded", e o hot path de fato é um event loop single-threaded. Mas o processo roda brevemente N+1 threads na inicialização: o loop principal de accept mais um conector por upstream. Quando os conectores têm sucesso, eles terminam. É justo dizer que o caminho de dados é single-threaded; não é justo dizer que o processo só tem uma thread.

No hot path, enviar um fd passa por `try_send_fd_with_reconnect`. Ele carrega o `ctrl_fd` com ordenação `Acquire`. Se o `sendmsg` falha com um errno recuperável (`EPIPE`, `ECONNRESET`, `EBADF` ou `ENOTCONN`), ele fecha o fd quebrado, armazena -1 e reconecta, até 3 tentativas espaçadas em 50ms, repetindo no máximo duas vezes antes de desistir e descartar a conexão. Então existe lógica real de reconexão aqui, não um envio fire-and-forget.

A seleção round-robin é o mais simples possível. Há um `let mut rr: usize = 0` no loop single-threaded, e a seleção é:

```rust
let idx = rr % upstreams.len();
rr = rr.wrapping_add(1);
```

Sem atomics, sem locks, porque há só uma thread escolhendo.

Uma palavra sobre `unsafe`: tem bastante, e tudo é para FFI com a libc e o push na submission queue do io-uring. Nada disso está fazendo algo exótico por performance. O SIGPIPE é setado para `SIG_IGN` na inicialização, que é o motivo de um worker sumindo virar um retorno `EPIPE` que o catraca trata, em vez de um sinal que mata o processo.

## O que o README simplifica demais

Ler o código contra o README revelou algumas lacunas honestas, e acho que vale dizê-las claramente.

A contagem de linhas está errada: são cerca de 450 linhas de lógica real, não 300. O piso de kernel está errado: `setup_single_issuer` empurra para Linux 6.0+, não 5.19+. E a maior delas: o README descreve o catraca como tendo "sem health checks, sem retries, de propósito", mas o código tem os dois. A lógica de reconexão acima é a história dos retries. E há um endpoint de health opcional e não documentado.

Se você setar `HEALTH_PATH` (uma quarta variável de ambiente, além de `PORT`, `BACKLOG` e `UPSTREAMS`), o catraca faz um `MSG_PEEK` de até 64 bytes numa conexão recém-aceita. Se esses bytes começam com `GET <path>`, o próprio catraca responde `HTTP/1.1 200 OK` e fecha a conexão. Essa requisição nunca chega a um worker. Isso é comportamento L7 genuíno vivendo dentro de uma ferramenta que se vende como L4 puro. É uma concessão pequena e pragmática, e vem desligada por padrão, então o caminho default realmente é L4 puro. Mas ele existe, e fingir o contrário seria desonesto.

Mais uma nota de honestidade: não há testes, não há benchmarks e não há CI no repositório. O único "benchmark" é a linha do README dizendo que foi usado em produção numa carga de benchmark. Então não vou citar nenhum número de latência, porque não há nenhum para citar.

## Rodando

```sh
cargo build --release

PORT=9999 \
UPSTREAMS=/run/api1.sock,/run/api2.sock \
./target/release/catraca
```

`UPSTREAMS` é obrigatória e é a lista de caminhos base dos UDS dos workers; o catraca deriva cada socket de controle adicionando `.ctrl`. Precisa de Linux 6.0+ e do `io_uring` não bloqueado por seccomp.

Se você escreve seus próprios workers e consegue implementar o contrato de recepção via `SCM_RIGHTS`, o catraca é um jeito muito pequeno e muito rápido de espalhar conexões entre eles, com a conexão entregue pelo kernel em vez de proxiada byte a byte. Leia o código você mesmo, é curto e recompensador: [github.com/maracatu-org/catraca](https://github.com/maracatu-org/catraca).
