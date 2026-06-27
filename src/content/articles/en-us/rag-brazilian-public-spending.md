---
title: "RAG over Brazil's public spending: the architecture of Calunga"
description: "How I built a chat plus RAG agent that answers plain-Portuguese questions about Brazilian public spending, grounded in real data and links to official sources."
pubDate: 2026-06-23
lang: "en-us"
tags: ["rag", "ai", "calunga"]
---

The data about Brazilian public spending is already public and already open. That is not the problem. The problem is that it sits across dozens of portals, in incompatible formats, behind bureaucratic language, with one CSV here and a paginated JSON API there. Open data only becomes oversight when a citizen can actually ask a question and trust the answer.

**Calunga** is my attempt to close that gap. It is a chat plus RAG product: an AI agent that reasons over public data with tools and semantic search, then answers in plain Portuguese with the numbers and links back to the official source. It is part of the larger Maracatu project, and every component is named after an element of the Pernambuco "maracatu", the cultural manifestation that gives the initiative its name.

## What you can ask

The whole thing earns its keep on questions like these:

```
"quanto o deputado X gastou com cota parlamentar em 2025?"
"a empresa que ganhou esse contrato federal está com a situação regular?"
"quem votou contra o PL 3802/2024 no Senado?"
"quais empresas mais receberam em contratos federais este ano?"
```

Each of those touches a different dataset, and the honest answer always carries a citation. That last constraint, citation or nothing, shaped almost every decision below.

## The components

| Name | What it is | Stack |
|------|-----------|-------|
| **Calunga** | the agent | LangGraph `create_react_agent`, Gemini 2.5 Flash-Lite |
| **Baque** | the ingestion pipeline | Dagster assets, Celery Beat |
| **Terreiro** | the backend | FastAPI, asyncpg, raw SQL |
| **Cortejo** | the frontend | Next.js 15, React 19, Vercel AI SDK |
| **Mineiro** | the embeddings service | BGE-M3, sentence-transformers |

## The agent

There is no hand-rolled graph here. Calunga is LangGraph's prebuilt `create_react_agent`, the classic ReAct loop between the LLM and a `ToolNode`, over the prebuilt `MessagesState`. I lowered `recursion_limit` to 8 on purpose: real questions resolve in 1 to 4 iterations, and a long loop just burns tokens and latency for no gain.

The model is Google `gemini-2.5-flash-lite` through `ChatGoogleGenerativeAI`, with `max_output_tokens` at 4096 and `streaming` on. I do not set a temperature. There is a model "router" in the code, but I want to be honest about what it is: a tier selector that always returns the cheapest model, flash-lite, with an optional Pro to flash-lite fallback that only fires if Pro is explicitly pinned. It is named like it does something clever; it mostly keeps the bill predictable.

## The 16 tools

The tools are async functions decorated with LangChain's `@tool`, each with a Pydantic v2 input schema. Every one returns a JSON string with a `mode` field in `{list, ranking, item, summary, empty, error}` and an always-present `source`. (The README says 14, but the code's `ALL_TOOLS` list has 16. Trust the code.)

| Tool | What it answers |
|------|-----------------|
| `buscar_despesas` | parliamentary expenses (CEAP): how much a deputy or senator spent |
| `ranking_despesas` | ranking of the biggest spenders, filtered by senador or deputado |
| `listar_parlamentares` | deputies and senators by type, state, party, name |
| `listar_executivos` | governors of the 27 states, mayors of the 27 capitals, the president (from TSE) |
| `buscar_empresa` | company by CNPJ: legal name, status, CNAE, address, sanctions |
| `buscar_similar` | free-text semantic search across all bases (the RAG tool) |
| `explicar_termo` | glossary of fiscal terms (LOA, LDO, PPA, RCL, CEAP, CPGF, Emenda Pix), itself RAG |
| `buscar_cpgf` | federal corporate card (CPGF) spending |
| `buscar_contratos` | federal contracts, with `group_by` for "which companies receive the most" |
| `buscar_viagens` | official paid travel |
| `buscar_emendas` | parliamentary amendments and execution (Pix amendments, secret budget) |
| `buscar_dados_fiscais` | state and capital fiscal data (RREO and RGF from SICONFI) |
| `buscar_despesas_federais` | federal budget execution (commitments, settlements, payments) by agency |
| `buscar_votacoes` | roll-call votes in Congress (Câmara and Senado) |
| `consultar_patrimonio_candidato` | declared assets of TSE candidates |
| `buscar_noticias` | recent web news via Tavily, for current facts not in the structured data |

## The RAG path

`buscar_similar` is the free-text retrieval tool. It embeds the query through Mineiro, then calls `busca_universal` in `app/queries/busca_semantica.py`.

The interesting design choice is that the `search.embeddings` table is polymorphic. One table, `embedding vector(1024)`, unique on `(reference_type, reference_id)`, with an HNSW index `USING hnsw (embedding vector_cosine_ops) WITH (m = 16, ef_construction = 200)`. Search is a single cosine query over everything:

```sql
SELECT e.reference_type AS tipo, e.reference_id AS referencia_id,
       1 - (e.embedding <=> $1::vector) AS score
FROM search.embeddings e
ORDER BY e.embedding <=> $1::vector
LIMIT $2
```

`<=>` is pgvector's cosine distance operator, and `score = 1 - distance`. The query over-fetches (`limit * 2`) and re-ranks, then for each hit does a typed second query to load the real row: `despesa` to `spending.ceap_expenses`, `contrato` to `spending.contracts`, `licitacao` to `spending.procurements`, `emenda` to `spending.amendments`, `proposicao` to `legislative.bills`, `votacao` to `legislative.voting_sessions`, `viagem` to `spending.trips`, `cpgf` to `spending.corporate_card_expenses`, `sancao` to `companies.sanctions`. Only then does it return the top N. The embedding is a fast first pass over a uniform vector space; the structured row is the truth that gets shown.

There is also a hybrid BM25 plus vector function, `busca_hibrida`, weighting dense 0.7 and sparse 0.3 with `websearch_to_tsquery('portuguese', ...)`. It is CEAP-only, though, and the live agent path uses the pure-vector `busca_universal`. I keep it around, but it is an aside.

### Mineiro, and one vector space

Mineiro is a standalone FastAPI service running `BAAI/bge-m3` at `EMBEDDING_DIM` 1024. It is TEI-compatible: `POST /embed` with `{"inputs": [...]}` returns `[[...]]`, and `GET /health` returns `{status, model, dim, device}`. It encodes with sentence-transformers, `normalize_embeddings` on, `batch_size` of `min(32, n)`, and picks its device automatically (cuda, then mps, then cpu), so it runs on Apple MPS for local development.

The thing that matters: ingestion and query time use the *same* model. One model means one vector space, so a query vector and a stored document vector are actually comparable. As a bonus, the API image never has to carry the ML stack, because embeddings live in their own service.

## The data plane, and why session pooling

There are two databases, on purpose. `maracatu_app` is transactional: auth and chat, schemas `auth` and `chat`. `maracatu_civic` is the large analytical one and the RAG home, schemas `reference`, `legislative`, `spending`, `companies`, `elections`, `ingestion`, `search`. No cross-database joins. The embeddings live in the civic DB, right next to the rows they reference, which is why the typed re-fetch above is a cheap local lookup. There are four connection roles, `app_write`, `app_read`, `civic_write`, `civic_read`, with read falling back to write.

Each database gets its own PgBouncer (`pgbouncer-app` with `MAX_CLIENT_CONN` 100, `pgbouncer-civic` with 200), on `edoburu/pgbouncer:v1.23.1-p2`, scram-sha-256. The pool mode is **session**, not transaction, and this is the part worth explaining. asyncpg uses server-side prepared statements. Transaction pooling hands you a different backend connection per transaction, so those prepared statements vanish out from under the driver and queries break. Session pooling pins a client to one backend for the life of the connection, which keeps asyncpg happy. It is a real documented constraint, not a preference. Postgres itself is `pgvector/pgvector:pg16` (I do not pin a specific pgvector version, so I will not claim one).

Splitting the data plane in two is also blast-radius isolation: a runaway analytical query on civic data cannot starve the pool that serves user login.

## Ingestion and the freshness SLA

Baque is `terreiro/pipeline/definitions.py`: Dagster software-defined assets, schedules, and sensors. The sources actually implemented in code are Câmara dos Deputados, Senado Federal, Portal da Transparência (sanctions CEIS/CNEP/CEPIM, CPGF, contracts, travel, amendments, federal budget), PNCP (procurement, which replaced the discontinued Transparência `/licitacoes` endpoint, now returning HTTP 400), Receita Federal (CNPJ bulk, filtered to only supplier CNPJs that already appear in spending, a deliberate memory and scale tradeoff), SICONFI (RREO plus RGF), and TSE (candidates and declared assets). The docs and README also mention TCU and BNDES, but those are not implemented: no services, no assets. I treat them as planned, not live.

Every run is wrapped and recorded in `ingestion.ingestion_log` (source, record_type, status, counts, timestamps), with `ingestion.raw_ingestion` holding JSONB payloads deduped by `payload_hash`. The embeddings asset batches 32, fetches in 5000-row windows, does `INSERT ... ON CONFLICT DO NOTHING`, sleeps one second between batches, and stops a window if zero rows embed, which is a guard for Mineiro being down.

Then there is a daily freshness monitor, `monitor_frescor`, on cron `0 7 * * *`. It compares each of 10 sources against a per-source SLA in days (CEAP 45, Votações 7, Contratos 35, CPGF 75, Viagens 45, Emendas 45, Orçamento 35, Licitações 10, SICONFI 75, Sanções 10), classifies each as OK, ATRASADA, or SEM DADO, and raises a Sentry alert (gated on `SENTRY_DSN`) plus a Dagster WARN asset check. Public data goes stale quietly. A civic tool that answers from stale data is worse than one that admits it does not know yet, so I would rather page myself.

## Anti-hallucination, and the TSE trick

Two design points carry more weight than the rest.

The first is an aggressive system prompt. The model is forbidden to write any URL, profile link, or ID that did not literally come from a tool result. The prompt puts it bluntly: a URL or ID that did not come from a tool return is a hallucination and breaks trust. Markdown links that arrive pre-embedded in tool fields must be preserved verbatim. Political identity, the office someone holds, their party, their link, must come from a tool, never from the model's memory. For a tool people are meant to fiscalize their government with, a confidently wrong link is the worst possible failure.

The second is a workaround for stale structured data. TSE returns who was *elected* in 2022 and 2024, not necessarily who holds office today. People resign, get removed, take leave, move up from vice. So when someone asks who is in office "today" or "right now", the prompt tells the model to also call `buscar_noticias` (Tavily) and present both: what the election data says, and what recent news says, each with its source. Structured data for the durable facts, news for the present tense.

## Shipping it without opening ports

Calunga runs at [maracatu.org](https://maracatu.org) on a self-hosted Linux host. Traefik v3.7 routes by container labels, and the only path in from the internet is a Cloudflare Tunnel (`cloudflared`, outbound only), with TLS terminated at Cloudflare and no inbound ports open on the host at all. The embeddings model runs on a modest consumer GPU on the same machine.

On the way out, when the chat endpoint `POST /v1/conversations` streams, Terreiro returns an SSE `EventSourceResponse`. The stream layer consumes LangGraph's `astream_events` v2 and emits typed events (`text`, `tool_start`, `tool_end`, `error`, `[DONE]`) plus per-tool metrics, and it persists the assistant message, with a `tool_calls` JSONB timeline, before its own `[DONE]`. There are guards before the agent runs: 8000 chars per message (HTTP 413), 60000 chars per request, and a daily quota of 200k input and 50k output tokens per user. The Next.js route in Cortejo proxies to the backend and transcodes the SSE into the Vercel AI SDK v1 data-stream protocol (`text` to `0:`, data and tool events to `2:`, error to `3:`, done to `d:`) with the header `x-vercel-ai-data-stream: v1`, and the frontend renders it with `@ai-sdk/react`'s `useChat`.

The point of all this is not the stack. It is that none of it matters unless a citizen can ask a question and trust the answer that comes back. The code is on [GitHub](https://github.com/maracatu-org/calunga), and you can try it at [maracatu.org](https://maracatu.org).
