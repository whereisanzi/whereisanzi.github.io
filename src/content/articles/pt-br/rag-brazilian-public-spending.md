---
title: "RAG sobre os gastos públicos do Brasil: a arquitetura do Calunga"
description: "Um produto de chat com RAG que responde perguntas em português claro sobre os gastos públicos brasileiros, com dados reais, gráficos e links para as fontes oficiais."
pubDate: 2026-06-23
lang: "pt-br"
tags: ["rag", "ia", "calunga"]
---

Os dados sobre os gastos públicos brasileiros já são públicos e abertos. O problema é que estão espalhados por dezenas de portais, em formatos diferentes, embrulhados em linguagem burocrática. O **Calunga** é uma tentativa de fechar essa lacuna: uma plataforma conversacional onde você pergunta em português claro e recebe uma resposta clara, com dados, gráficos e links para a fonte oficial.

É um produto de chat com RAG. Um agente de IA raciocina sobre os dados públicos com ferramentas e busca semântica, em vez de chutar a partir do conjunto de treino.

## Perguntas que ele foi feito para responder

```
"quanto o deputado X gastou em 2025?"
"essa empresa que recebeu o contrato é regular?"
"quem votou contra o PL 3802/2024?"
```

Cada uma dessas toca um dataset diferente, e a resposta honesta sempre vem com a citação da fonte.

## O plano de dados

O agente só é tão bom quanto os dados por trás dele. O Calunga ingere das fontes públicas primárias: Câmara dos Deputados, Senado Federal, Portal da Transparência, o portal de contratações PNCP, Receita Federal (o cadastro de CNPJ), SICONFI do Tesouro Nacional e os dados eleitorais do TSE.

Esses dados vivem em dois bancos PostgreSQL 16 separados, cada um atrás do seu próprio PgBouncer:

- `maracatu_app` guarda autenticação e chat.
- `maracatu_civic` guarda os dados públicos: referência, legislativo, gastos, empresas, eleições, ingestão e busca.

Dividir o plano de dados em dois é principalmente sobre isolar o raio de impacto. Uma query analítica descontrolada nos dados cívicos não pode sufocar o pool de conexões que atende o login do usuário.

## O agente

O agente em si é construído com **LangGraph** em cima do **Gemini 2.5 Flash-Lite**, e tem 14 ferramentas. Algumas rodam busca semântica; outras rodam SQL direcionado contra o banco cívico. A recuperação usa **pgvector** para similaridade vetorial, e os embeddings vêm do **BGE-M3** (1024 dimensões) servido por um pequeno serviço interno chamado **Mineiro**, atrás de um endpoint `/embed` compatível com TEI. Manter os embeddings no próprio serviço significa que a imagem da API nunca precisa carregar a stack de ML.

## Componentes, batizados pela festa

O Calunga faz parte do projeto Maracatu, e suas partes têm nomes de elementos da manifestação cultural pernambucana que dá nome à iniciativa:

| Nome | O que é |
|------|---------|
| **Calunga** | o agente de IA (LangGraph + Gemini, 14 ferramentas) |
| **Baque** | o pipeline de ingestão (Dagster + Celery) |
| **Terreiro** | a API REST (FastAPI, asyncpg, SQL cru) |
| **Cortejo** | o frontend web (Next.js 15, Vercel AI SDK, Recharts) |
| **Mineiro** | o serviço de embeddings (BGE-M3) |

A ingestão não é única. Cada execução é registrada num `ingestion_log`, e uma checagem diária de frescor compara cada fonte com um SLA por fonte, disparando um alerta quando uma fonte fica para trás. Dado público envelhece em silêncio, e uma ferramenta cívica que responde com dado velho é pior que uma que admite não saber.

## Colocando no ar sem abrir portas

O Calunga roda em [maracatu.org](https://maracatu.org) num host Linux self-hosted. O Traefik v3 cuida do roteamento por labels de container, e o único caminho de entrada da internet é um Cloudflare Tunnel, com TLS terminado na Cloudflare e nenhuma porta de entrada aberta no host. O modelo de embeddings roda numa GPU de consumo modesta na mesma máquina.

O ponto de tudo isso não é a stack. É que dado aberto só vira fiscalização quando um cidadão consegue de fato fazer uma pergunta e confiar na resposta. O código está no [GitHub](https://github.com/maracatu-org/calunga).
