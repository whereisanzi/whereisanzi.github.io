---
title: "Handoff de conexão zero-copy em Rust com io_uring e SCM_RIGHTS"
description: "Como o catraca aceita conexões TCP com io_uring AcceptMulti e entrega o file descriptor cru para workers locais, sem nunca ler um byte."
pubDate: 2026-06-25
lang: "pt-br"
tags: ["rust", "io_uring", "sistemas"]
---

**catraca** é um dispatcher TCP single-host em Rust. O nome diz tudo: ele controla quem passa e para onde vai. Aceita conexões TCP, escolhe um worker local em round-robin e faz o handoff da conexão. A parte interessante é que ele nunca lê um único byte da requisição. O kernel entrega o socket aberto direto para o worker.

## Não é um reverse proxy

Ajuda dizer o que o catraca não é. Ele é um dispatcher de conexão L4, não um reverse proxy L7. Não consegue rotear por path, header ou hostname, porque nunca faz parsing da requisição. Não tem TLS, não tem HTTP, não tem health check, retry nem métrica. De propósito.

O que você ganha em troca são cerca de 300 linhas, duas dependências (`libc` e `io-uring`), nenhum runtime async e zero pressão no alocador no hot path. É uma categoria de ferramenta diferente de NGINX ou Envoy, útil em exatamente uma situação: workers no mesmo host que você quer alimentar com o mínimo de overhead de latência.

## O lado do accept: io_uring AcceptMulti

O listener roda em uma única thread com uma única instância de io_uring. Em vez de submeter um accept por conexão, o catraca submete um accept multishot (`AcceptMulti`, o `IORING_OP_ACCEPT` em modo multishot, disponível desde o Linux 5.19). Uma única entrada na submission queue passa a produzir uma completion para cada conexão que chega, sem resubmissão. O `SO_REUSEPORT` fica setado no listener, então várias instâncias do catraca poderiam compartilhar a porta para um fanout consciente de NUMA.

## O handoff: SCM_RIGHTS por um socket Unix

Esse é o truque central. Um file descriptor é só um índice numa tabela por processo, então você não pode mandar ele para outro processo escrevendo o número. Mas sockets de domínio Unix permitem passar um descriptor de verdade por uma mensagem auxiliar do tipo `SCM_RIGHTS`. O kernel instala no processo que recebe um novo descriptor apontando para o mesmo arquivo aberto, aqui o socket TCP do cliente.

O catraca se conecta ao socket de controle de cada worker (o caminho UDS do worker com `.ctrl` no final) e, para cada conexão aceita, envia um byte mais uma mensagem de controle carregando o fd do cliente. O worker que recebe assume a propriedade e atende a requisição de ponta a ponta. Nenhum byte é copiado entre a conexão e o worker.

O lado do worker no contrato é um único `recvmsg`:

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
// client_fd é seu
```

## Uma escolha que vale explicar

Seria natural submeter o `sendmsg` do handoff também pelo io_uring, para manter tudo no ring. O catraca não faz isso. O handoff é um syscall `sendmsg` síncrono na thread de accept, de propósito: para um payload de um byte mais uma única mensagem de controle, o custo de submeter a operação pelo io_uring é maior que simplesmente fazer o syscall. O índice de round-robin é um `usize` que dá wrap, sem sincronização, porque existe só uma thread. Menos maquinário, menos latência.

## Rodando

```sh
cargo build --release

PORT=9999 \
UPSTREAMS=/run/api1.sock,/run/api2.sock \
./target/release/catraca
```

`UPSTREAMS` é a lista de caminhos base dos UDS dos workers; o catraca deriva cada socket de controle adicionando `.ctrl`. Precisa de Linux 5.19+ e do `io_uring` não bloqueado por seccomp.

O catraca é alpha, e já foi usado em produção para uma carga de benchmark, mas ainda não foi endurecido contra tráfego adversarial. Se você escreve seus próprios workers e consegue implementar o contrato de recepção via `SCM_RIGHTS`, ele é um jeito muito pequeno e muito rápido de espalhar conexões entre eles. O código está no [GitHub](https://github.com/maracatu-org/catraca).
