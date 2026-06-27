---
title: "RAG sobre os gastos públicos do Brasil: a arquitetura do Calunga"
description: "Como construí um agente de chat com RAG que responde perguntas em português claro sobre os gastos públicos brasileiros, ancorado em dados reais e links para as fontes oficiais."
pubDate: 2026-06-23
lang: "pt-br"
tags: ["rag", "ia", "calunga"]
---

Os dados sobre os gastos públicos brasileiros já são públicos e já são abertos. Esse não é o problema. O problema é que eles ficam espalhados por dezenas de portais, em formatos incompatíveis, embrulhados em linguagem burocrática, com um CSV aqui e uma API JSON paginada ali. Dado aberto só vira fiscalização quando um cidadão consegue de fato fazer uma pergunta e confiar na resposta.

O **Calunga** é a minha tentativa de fechar essa lacuna. É um produto de chat com RAG: um agente de IA que raciocina sobre os dados públicos com ferramentas e busca semântica, e então responde em português claro com os números e os links de volta para a fonte oficial. Faz parte do projeto Maracatu, maior, e cada componente leva o nome de um elemento do maracatu pernambucano, a manifestação cultural que dá nome à iniciativa.

## O que dá pra perguntar

A coisa toda se justifica em perguntas como estas:

```
"quanto o deputado X gastou com cota parlamentar em 2025?"
"a empresa que ganhou esse contrato federal está com a situação regular?"
"quem votou contra o PL 3802/2024 no Senado?"
"quais empresas mais receberam em contratos federais este ano?"
```

Cada uma toca um dataset diferente, e a resposta honesta sempre vem com a citação da fonte. Essa última restrição, citação ou nada, moldou quase todas as decisões abaixo.

## Os componentes

| Nome | O que é | Stack |
|------|---------|-------|
| **Calunga** | o agente | LangGraph `create_react_agent`, Gemini 2.5 Flash-Lite |
| **Baque** | o pipeline de ingestão | Dagster assets, Celery Beat |
| **Terreiro** | o backend | FastAPI, asyncpg, SQL cru |
| **Cortejo** | o frontend | Next.js 15, React 19, Vercel AI SDK |
| **Mineiro** | o serviço de embeddings | BGE-M3, sentence-transformers |

## O agente

Não tem grafo feito à mão aqui. O Calunga é o `create_react_agent` pronto do LangGraph, o clássico loop ReAct entre o LLM e um `ToolNode`, sobre o `MessagesState` pronto. Abaixei o `recursion_limit` para 8 de propósito: perguntas reais se resolvem em 1 a 4 iterações, e um loop longo só queima tokens e latência sem ganho nenhum.

O modelo é o `gemini-2.5-flash-lite` do Google, via `ChatGoogleGenerativeAI`, com `max_output_tokens` em 4096 e `streaming` ligado. Não defino temperatura. Existe um "router" de modelo no código, mas quero ser honesto sobre o que ele é: um seletor de tier que sempre devolve o modelo mais barato, o flash-lite, com um fallback opcional de Pro para flash-lite que só dispara se o Pro estiver explicitamente fixado. O nome dele sugere algo esperto; na prática ele mantém a conta previsível.

## As 16 ferramentas

As ferramentas são funções assíncronas decoradas com o `@tool` do LangChain, cada uma com um schema de entrada em Pydantic v2. Toda ferramenta retorna uma string JSON com um campo `mode` em `{list, ranking, item, summary, empty, error}` e um `source` sempre presente. (O README diz 14, mas a lista `ALL_TOOLS` do código tem 16. Confie no código.)

| Ferramenta | O que responde |
|------------|----------------|
| `buscar_despesas` | despesas parlamentares (CEAP): quanto um deputado ou senador gastou |
| `ranking_despesas` | ranking dos maiores gastadores, com filtro senador ou deputado |
| `listar_parlamentares` | deputados e senadores por tipo, estado, partido, nome |
| `listar_executivos` | governadores dos 27 estados, prefeitos das 27 capitais, o presidente (via TSE) |
| `buscar_empresa` | empresa por CNPJ: razão social, situação, CNAE, endereço, sanções |
| `buscar_similar` | busca semântica em texto livre sobre todas as bases (a ferramenta de RAG) |
| `explicar_termo` | glossário de termos fiscais (LOA, LDO, PPA, RCL, CEAP, CPGF, Emenda Pix), ele mesmo um RAG |
| `buscar_cpgf` | gastos no cartão de pagamento do governo federal (CPGF) |
| `buscar_contratos` | contratos federais, com `group_by` para "quais empresas mais recebem" |
| `buscar_viagens` | viagens oficiais pagas |
| `buscar_emendas` | emendas parlamentares e execução (emendas Pix, orçamento secreto) |
| `buscar_dados_fiscais` | dados fiscais de estados e capitais (RREO e RGF do SICONFI) |
| `buscar_despesas_federais` | execução do orçamento federal (empenho, liquidação, pagamento) por órgão |
| `buscar_votacoes` | votações nominais no Congresso (Câmara e Senado) |
| `consultar_patrimonio_candidato` | patrimônio declarado de candidatos no TSE |
| `buscar_noticias` | notícias recentes da web via Tavily, para fatos atuais que não estão nos dados estruturados |

## O caminho do RAG

O `buscar_similar` é a ferramenta de recuperação em texto livre. Ela embeda a consulta pelo Mineiro e então chama o `busca_universal` em `app/queries/busca_semantica.py`.

A escolha de design interessante é que a tabela `search.embeddings` é polimórfica. Uma tabela só, `embedding vector(1024)`, única em `(reference_type, reference_id)`, com índice HNSW `USING hnsw (embedding vector_cosine_ops) WITH (m = 16, ef_construction = 200)`. A busca é uma única consulta por cosseno sobre tudo:

```sql
SELECT e.reference_type AS tipo, e.reference_id AS referencia_id,
       1 - (e.embedding <=> $1::vector) AS score
FROM search.embeddings e
ORDER BY e.embedding <=> $1::vector
LIMIT $2
```

`<=>` é o operador de distância de cosseno do pgvector, e `score = 1 - distância`. A consulta busca a mais (`limit * 2`) e reordena, e então, para cada acerto, faz uma segunda consulta tipada para carregar a linha real: `despesa` para `spending.ceap_expenses`, `contrato` para `spending.contracts`, `licitacao` para `spending.procurements`, `emenda` para `spending.amendments`, `proposicao` para `legislative.bills`, `votacao` para `legislative.voting_sessions`, `viagem` para `spending.trips`, `cpgf` para `spending.corporate_card_expenses`, `sancao` para `companies.sanctions`. Só então devolve os top N. O embedding é uma primeira passada rápida sobre um espaço vetorial uniforme; a linha estruturada é a verdade que aparece pro usuário.

Existe também uma função híbrida de BM25 mais vetor, `busca_hibrida`, com pesos denso 0.7 e esparso 0.3 usando `websearch_to_tsquery('portuguese', ...)`. Mas ela é só de CEAP, e o caminho do agente no ar usa o `busca_universal`, puro vetor. Mantenho ela por perto, mas é um aparte.

### Mineiro, e um só espaço vetorial

O Mineiro é um serviço FastAPI independente rodando o `BAAI/bge-m3` com `EMBEDDING_DIM` 1024. É compatível com TEI: `POST /embed` com `{"inputs": [...]}` devolve `[[...]]`, e `GET /health` devolve `{status, model, dim, device}`. Ele codifica com sentence-transformers, `normalize_embeddings` ligado, `batch_size` de `min(32, n)`, e escolhe o device automaticamente (cuda, depois mps, depois cpu), então roda em Apple MPS no desenvolvimento local.

O que importa: a ingestão e o tempo de consulta usam o *mesmo* modelo. Um modelo significa um espaço vetorial, então o vetor da consulta e o vetor de um documento guardado são de fato comparáveis. De brinde, a imagem da API nunca precisa carregar a stack de ML, porque os embeddings vivem no próprio serviço.

## O plano de dados, e por que session pooling

São dois bancos, de propósito. O `maracatu_app` é transacional: autenticação e chat, schemas `auth` e `chat`. O `maracatu_civic` é o grande, analítico, e a casa do RAG, schemas `reference`, `legislative`, `spending`, `companies`, `elections`, `ingestion`, `search`. Sem joins entre bancos. Os embeddings vivem no banco cívico, bem ao lado das linhas que referenciam, e é por isso que o re-fetch tipado lá de cima é uma consulta local barata. São quatro papéis de conexão, `app_write`, `app_read`, `civic_write`, `civic_read`, com o de leitura caindo de volta no de escrita.

Cada banco ganha o seu próprio PgBouncer (`pgbouncer-app` com `MAX_CLIENT_CONN` 100, `pgbouncer-civic` com 200), na imagem `edoburu/pgbouncer:v1.23.1-p2`, scram-sha-256. O pool mode é **session**, não transaction, e essa é a parte que vale explicar. O asyncpg usa prepared statements no lado do servidor. O transaction pooling te dá uma conexão de backend diferente a cada transação, então esses prepared statements somem por baixo do driver e as queries quebram. O session pooling fixa um cliente a um backend pela vida da conexão, o que deixa o asyncpg feliz. É uma restrição real e documentada, não preferência. O Postgres em si é `pgvector/pgvector:pg16` (não fixo uma versão específica do pgvector, então não vou afirmar uma).

Dividir o plano de dados em dois também isola o raio de impacto: uma query analítica descontrolada nos dados cívicos não pode sufocar o pool que atende o login do usuário.

## Ingestão e o SLA de frescor

O Baque é o `terreiro/pipeline/definitions.py`: assets definidos por software no Dagster, schedules e sensors. As fontes de fato implementadas no código são Câmara dos Deputados, Senado Federal, Portal da Transparência (sanções CEIS/CNEP/CEPIM, CPGF, contratos, viagens, emendas, orçamento federal), PNCP (contratações, que substituiu o endpoint `/licitacoes` descontinuado da Transparência, hoje retornando HTTP 400), Receita Federal (CNPJ em massa, filtrado só para os CNPJs de fornecedores que já aparecem nos gastos, um tradeoff deliberado de memória e escala), SICONFI (RREO mais RGF) e TSE (candidatos e patrimônio declarado). A documentação e o README também citam TCU e BNDES, mas esses não estão implementados: sem serviços, sem assets. Trato eles como planejados, não no ar.

Toda execução é embrulhada e registrada em `ingestion.ingestion_log` (fonte, tipo de registro, status, contagens, timestamps), com `ingestion.raw_ingestion` guardando os payloads em JSONB deduplicados por `payload_hash`. O asset de embeddings faz lotes de 32, busca em janelas de 5000 linhas, faz `INSERT ... ON CONFLICT DO NOTHING`, dorme um segundo entre lotes, e para uma janela se zero linhas embedam, o que é uma proteção para o caso do Mineiro estar fora do ar.

Aí tem um monitor diário de frescor, o `monitor_frescor`, no cron `0 7 * * *`. Ele compara cada uma das 10 fontes com um SLA por fonte em dias (CEAP 45, Votações 7, Contratos 35, CPGF 75, Viagens 45, Emendas 45, Orçamento 35, Licitações 10, SICONFI 75, Sanções 10), classifica cada uma como OK, ATRASADA ou SEM DADO, e dispara um alerta no Sentry (condicionado ao `SENTRY_DSN`) mais um asset check WARN no Dagster. Dado público envelhece em silêncio. Uma ferramenta cívica que responde com dado velho é pior que uma que admite não saber ainda, então prefiro me alertar.

## Anti-alucinação, e o truque do TSE

Dois pontos de design pesam mais que o resto.

O primeiro é um system prompt agressivo. O modelo é proibido de escrever qualquer URL, link de perfil ou ID que não tenha vindo literalmente do retorno de uma ferramenta. O prompt coloca sem rodeios: uma URL ou ID que não veio de um retorno de ferramenta é alucinação e quebra a confiança. Links em markdown que chegam já embutidos nos campos da ferramenta precisam ser preservados na íntegra. Identidade política, o cargo que alguém ocupa, o partido, o link, precisa vir de uma ferramenta, nunca da memória do modelo. Para uma ferramenta com a qual as pessoas vão fiscalizar o próprio governo, um link confiantemente errado é a pior falha possível.

O segundo é um contorno para o dado estruturado velho. O TSE devolve quem foi *eleito* em 2022 e 2024, não necessariamente quem ocupa o cargo hoje. Gente renuncia, é cassada, se licencia, sobe de vice. Então quando alguém pergunta quem está no cargo "hoje" ou "agora", o prompt manda o modelo também chamar o `buscar_noticias` (Tavily) e apresentar os dois: o que o dado eleitoral diz, e o que a notícia recente diz, cada um com a sua fonte. Dado estruturado para os fatos duráveis, notícia para o presente.

## Colocando no ar sem abrir portas

O Calunga roda em [maracatu.org](https://maracatu.org) num host Linux self-hosted. O Traefik v3.7 roteia por labels de container, e o único caminho de entrada da internet é um Cloudflare Tunnel (`cloudflared`, só saída), com TLS terminado na Cloudflare e nenhuma porta de entrada aberta no host. O modelo de embeddings roda numa GPU de consumo modesta na mesma máquina.

Na saída, quando o endpoint de chat `POST /v1/conversations` faz streaming, o Terreiro devolve um `EventSourceResponse` por SSE. A camada de stream consome o `astream_events` v2 do LangGraph e emite eventos tipados (`text`, `tool_start`, `tool_end`, `error`, `[DONE]`) mais métricas por ferramenta, e persiste a mensagem do assistente, com uma timeline de `tool_calls` em JSONB, antes do seu próprio `[DONE]`. Tem guardas antes de o agente rodar: 8000 caracteres por mensagem (HTTP 413), 60000 caracteres por requisição, e uma cota diária de 200k tokens de entrada e 50k de saída por usuário. A rota Next.js no Cortejo faz proxy para o backend e transcodifica o SSE no protocolo data-stream v1 do Vercel AI SDK (`text` para `0:`, eventos de dados e ferramenta para `2:`, erro para `3:`, done para `d:`) com o header `x-vercel-ai-data-stream: v1`, e o frontend renderiza com o `useChat` do `@ai-sdk/react`.

O ponto de tudo isso não é a stack. É que nada disso importa a menos que um cidadão consiga fazer uma pergunta e confiar na resposta que volta. O código está no [GitHub](https://github.com/maracatu-org/calunga), e dá pra testar em [maracatu.org](https://maracatu.org).
