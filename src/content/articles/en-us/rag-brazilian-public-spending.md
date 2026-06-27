---
title: "RAG over Brazil's public spending: the architecture of Calunga"
description: "A chat plus RAG product that answers plain-Portuguese questions about Brazilian public spending, with real data, charts and links to official sources."
pubDate: 2026-06-23
lang: "en-us"
tags: ["rag", "ai", "calunga"]
---

The data about Brazilian public spending is already public and open. The problem is that it is scattered across dozens of portals, in different formats, wrapped in bureaucratic language. **Calunga** is an attempt to close that gap: a conversational platform where you ask in plain Portuguese and get a clear answer, with data, charts and links to the official source.

It is a chat plus RAG product. An AI agent reasons over the public data with tools and semantic search, instead of guessing from its training set.

## Questions it is built to answer

```
"quanto o deputado X gastou em 2025?"
"essa empresa que recebeu o contrato é regular?"
"quem votou contra o PL 3802/2024?"
```

Each of those touches a different dataset, and the honest answer always comes with a citation.

## The data plane

The agent is only as good as the data behind it. Calunga ingests from the primary public sources: Câmara dos Deputados, Senado Federal, Portal da Transparência, the PNCP procurement portal, Receita Federal (the CNPJ registry), SICONFI from the National Treasury, and the TSE electoral data.

That data lives in two separate PostgreSQL 16 databases, each behind its own PgBouncer:

- `maracatu_app` holds auth and chat.
- `maracatu_civic` holds the public data: reference, legislative, spending, companies, elections, ingestion and search.

Splitting the data plane in two is mostly about blast-radius isolation. A runaway analytical query on civic data cannot starve the connection pool that serves user login.

## The agent

The agent itself is built with **LangGraph** on top of **Gemini 2.5 Flash-Lite**, and it has 14 tools. Some tools run semantic search; others run targeted SQL against the civic database. Retrieval uses **pgvector** for vector similarity, and the embeddings come from **BGE-M3** (1024 dimensions) served by a small internal service called **Mineiro** behind a TEI-compatible `/embed` endpoint. Keeping embeddings in their own service means the API image never has to carry the ML stack.

## Components, named after the festival

Calunga is part of the Maracatu project, and its parts are named after elements of the Pernambuco cultural manifestation that gives the initiative its name:

| Name | What it is |
|------|------------|
| **Calunga** | the AI agent (LangGraph + Gemini, 14 tools) |
| **Baque** | the ingestion pipeline (Dagster + Celery) |
| **Terreiro** | the REST API (FastAPI, asyncpg, raw SQL) |
| **Cortejo** | the web frontend (Next.js 15, Vercel AI SDK, Recharts) |
| **Mineiro** | the embeddings service (BGE-M3) |

Ingestion is not a one-off. Every run is recorded in an `ingestion_log`, and a daily freshness check compares each source against a per-source SLA, raising an alert when a source falls behind. Public data goes stale quietly, and a civic tool that answers from stale data is worse than one that admits it does not know.

## Shipping it without opening ports

Calunga runs at [maracatu.org](https://maracatu.org) on a self-hosted Linux host. Traefik v3 handles routing by container labels, and the only path in from the internet is a Cloudflare Tunnel, with TLS terminated at Cloudflare and no inbound ports open on the host. The embeddings model runs on a modest consumer GPU on the same machine.

The point of all this is not the stack. It is that open data only becomes oversight when a citizen can actually ask a question and trust the answer. The code is on [GitHub](https://github.com/maracatu-org/calunga).
