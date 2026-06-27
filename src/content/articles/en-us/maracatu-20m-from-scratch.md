---
title: "Training Maracatu-20M: a Brazilian Portuguese LLM from scratch"
description: "Why I trained a 17M-parameter Portuguese model from zero, and the corpus, tokenizer and architecture choices behind it."
pubDate: 2026-06-27
lang: "en-us"
tags: ["llm", "pytorch", "maracatu"]
---

Maracatu is an open-source project to pretrain language models in Brazilian Portuguese, with open weights under Apache 2.0 and a focus on national AI sovereignty. The first two models, **Maracatu-20M** (17M parameters) and **Maracatu-80M** (87.8M), are small on purpose. This post is about the smaller one, and why training something tiny from scratch is still worth doing.

## Why train small

A 17M-parameter model will not write your code or pass a bar exam. That was never the point. Small models are a forcing function: every decision about data, tokenizer and architecture shows up immediately in the loss curve, and you can run a full training cycle on a single modest GPU. You learn the whole pipeline end to end instead of renting intuition from someone else's checkpoint.

Maracatu-20M reached a validation perplexity of **23.81** on Wikipedia PT (~550M tokens). Maracatu-80M, trained on a larger mix (Wikipedia + Gutenberg + CulturaX-PT, ~1.6B tokens), got to **21.34**. Those numbers are not state of the art, and they are not supposed to be. They are honest baselines for Portuguese, published with their weights so anyone can reproduce and beat them.

## The corpus you can legally train on

The single most underrated decision is what you put in. I only used sources with licenses compatible with Apache 2.0:

- **Wikipedia PT**, CC BY-SA: 979k articles, around 550M BPE tokens.
- **Project Gutenberg**, public domain: Machado de Assis, José de Alencar and other Brazilian classics.
- **CulturaX-PT**, a subset filtered for Brazilian Portuguese.

Cleaning matters as much as collecting. The corpus pipeline downloads Wikipedia PT through the `datasets` library, cleans it, and writes a single `corpus.txt`. Garbage in the corpus is the cheapest way to waste GPU hours.

## A tokenizer trained for Portuguese

I trained a **SentencePiece BPE tokenizer with a 16k vocabulary** directly on the PT-BR corpus, instead of reusing an English-first vocabulary. A tokenizer tuned for Portuguese spends fewer tokens on the same text, which means more effective context and cheaper training for the same number of words.

## Architecture: a small Llama

The model is a decoder-only transformer in the Llama style, with the components that have become standard:

- RMSNorm
- Rotary position embeddings (RoPE)
- SwiGLU feed-forward
- No bias in `nn.Linear`
- Weight tying between the embedding and the output projection

One choice paid off more than any other: the state dict is **aligned with Hugging Face's `LlamaForCausalLM`**. That means the published weights load through `transformers` with no conversion script. You do not need to know anything about my training code to use the model.

## The whole loop in four commands

The framework is PyTorch, and the pedagogical foundation is Andrej Karpathy's nanoGPT. The full cycle is small enough to read:

```bash
python scripts/clean_corpus.py                              # prepare corpus
python tokenizer/train_tokenizer.py                         # train tokenizer
python -m maracatu.train --config configs/maracatu_20m.yaml # train model
python -m maracatu.sample --checkpoint checkpoints/latest.pt --prompt "O Brasil é"
```

Hyperparameters live in YAML configs, so a new run is a new file, not a new branch. Evaluation runs against Brazilian exams (ENEM, ASSIN) through `lm-evaluation-harness`.

## Why it matters

Most of the open Portuguese models we use are afterthoughts of English-first training. Building one from scratch, with an open corpus and open weights, is a small act of sovereignty: it puts the whole recipe in the open where the Brazilian community can inspect, fork and improve it.

The weights are on [Hugging Face](https://huggingface.co/maracatu-labs) and [Ollama](https://ollama.com/whereisanzi). The code is on [GitHub](https://github.com/maracatu-org/maracatu). Pull requests, corpus improvements and new benchmarks are all welcome.
