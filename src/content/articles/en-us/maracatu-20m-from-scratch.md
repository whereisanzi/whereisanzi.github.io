---
title: "Training Maracatu-20M: a Brazilian Portuguese LLM from scratch"
description: "A small Llama-style model trained on a legally clean Portuguese corpus, with the architecture, training loop and honest benchmarks behind it."
pubDate: 2026-06-27
lang: "en-us"
tags: ["llm", "pytorch", "maracatu"]
---

Maracatu is an open-source project to pretrain language models in Brazilian Portuguese, with open weights under Apache 2.0 and a focus on AI sovereignty. The first two models, **Maracatu-20M** and **Maracatu-80M**, are small on purpose. This post is mostly about the smaller one, with the 80M model as the counterpoint that shows what changes when you scale a little.

I want to be honest from the first paragraph: these are tiny models, and on most multiple-choice benchmarks they sit at or below random chance. That is not a failure to hide, it is the point of publishing baselines. What I learned building the pipeline is worth far more than any leaderboard line.

## Why train small

A 17M-parameter model will not write your code or pass a bar exam. Small models are a forcing function: every decision about data, tokenizer and architecture shows up immediately in the loss curve, and a full training cycle fits on a single modest GPU. You learn the whole pipeline end to end instead of renting intuition from someone else's checkpoint.

Maracatu-20M has **16.77M total parameters** (10.62M of them outside the embedding table). Maracatu-80M has **87.80M total** (75.52M non-embedding). Here is the full shape of both:

| Config | 20M | 80M |
| --- | --- | --- |
| Layers | 6 | 12 |
| Hidden size | 384 | 768 |
| Attention heads | 6 | 12 |
| KV heads | 6 (no GQA) | 4 (GQA 3:1) |
| Head dim | 64 | 64 |
| Intermediate (SwiGLU) | 1024 | 2048 |
| Context length | 512 | 1024 |
| Vocab | 16000 | 16000 |

The 80M run is the first time the project used grouped-query attention in a real training run, following the Llama-3 3:1 pattern, and it ran with no loss instability at all.

## Architecture: a small Llama, not a small GPT-2

People assume "trained from scratch in the spirit of nanoGPT" means a GPT-2 clone. The training **loop** is inspired by Karpathy's nanoGPT, but the **architecture** is squarely Llama-style. That distinction is the whole design. The implementation lives in `src/maracatu/model.py`:

- **RMSNorm**, no bias. It casts to fp32, computes `variance = x.pow(2).mean(-1)`, then `x * rsqrt(variance + eps)` with `eps = 1e-5`.
- **RoPE** using the Hugging Face rotate-half convention, with `inv_freq = 1 / (theta ** (arange(0, head_dim, 2) / head_dim))` and `rope_theta = 10000`. The frequencies are cached as **non-persistent buffers**, so they never enter the state dict. That detail matters for clean Hugging Face loading later.
- **Attention** with separate `q_proj`, `k_proj`, `v_proj` and `o_proj`, all `bias=False`. GQA is done with `repeat_interleave` on the KV heads, and the actual attention is `F.scaled_dot_product_attention(is_causal=True)`. On CUDA, PyTorch SDPA dispatches to FlashAttention kernels by itself, so there is no `flash-attn` dependency.
- **SwiGLU MLP**: `down_proj(F.silu(gate_proj(x)) * up_proj(x))`, again `bias=False`.
- **Pre-norm decoder layers** and **weight tying**, where `lm_head.weight` is the same tensor as `embed_tokens.weight`.

Initialization is `normal_(0, 0.02)`, with one explicit nanoGPT inheritance: the GPT-2-style residual-scaled re-init of `o_proj` and `down_proj` to `std = 0.02 / sqrt(2 * num_layers)`. That keeps the residual stream from blowing up as depth grows.

## The Hugging Face state dict, by construction

This is the cleanest technical win of the project, so it gets its own section. The export script `scripts/export_hf.py` does not convert anything: every parameter name is **authored from the start** to match HF Llama exactly. So you get `model.embed_tokens`, `model.layers[i].self_attn.{q,k,v,o}_proj`, `mlp.{gate,up,down}_proj`, `input_layernorm`, `post_attention_layernorm`, `model.norm` and `lm_head`, with no remapping table anywhere.

Export does only the small honest things:

- strip the `_orig_mod.` prefix that `torch.compile` adds;
- if `tie_word_embeddings` is set, delete `lm_head.weight` so HF re-ties it;
- `load_state_dict(strict=False)`, because the RoPE buffers are non-persistent and simply are not there.

A `verify_equivalence` step feeds identical random token ids to both the Maracatu implementation and the `transformers` one and asserts `max_abs_diff <= 1e-3`. The published models validated at `max_abs_diff = 0.0`. The `config.json` declares `architectures: ["LlamaForCausalLM"]`, so the weights load through `transformers` with no conversion script and no surprises.

## A tokenizer built for Portuguese

I trained a **SentencePiece BPE tokenizer** directly on the corpus (`tokenizer/train_tokenizer.py`): `model_type bpe`, `vocab_size 16000`, `character_coverage 0.9995`, `split_digits`, `byte_fallback`, and `remove_extra_whitespaces`. Special tokens are `pad=0 <pad>`, `unk=1 <unk>`, `bos=2 <s>`, `eos=3 </s>`.

One choice is a real, documented limitation: the normalization rule is `nmt_nfkc_cf`, which is NFKC plus casefold. That makes the model **lowercase-only**. It simplifies the vocabulary and helps a tiny model, but it means casing information is gone before training even starts. I would rather write that down than pretend it is a feature.

The data loader tokenizes the whole corpus into a single `uint16` `.npy` file, appends `</s>` after every line, and uses a chronological tail split for validation (the last 0.5% of the corpus is the holdout). Training reads random contiguous windows of `context_size` from the array.

## The corpus you can legally train on

The single most underrated decision is what you put in. I only used sources with licenses compatible with Apache 2.0, and I documented exactly what got dropped.

**Corpus v1 (for the 20M model)** is `wikimedia/wikipedia`, config `20231101.pt`. The filter chain drops documents under 200 characters, drops lines under 30 characters, drops symbol- or number-only lines, normalizes whitespace, and does exact SHA-1 line dedup. The result is **979,492 articles**, about **599M BPE tokens** after tokenization. The model saw roughly **410M tokens** across 50k steps, about 0.75 of an epoch.

**Corpus v2 (for the 80M model)** keeps the same Wikipedia dump and adds two sources: Project Gutenberg PT (24 hardcoded public-domain works by Machado de Assis, José de Alencar, Aluísio Azevedo, Eça de Queirós, Graciliano Ramos, Lima Barreto and others, scraped at 1 request per second with headers stripped) and CulturaX-PT (`uonlp/CulturaX`, config `pt`, ODC-BY, read in streaming). Total is about **1.60B tokens**. The Carolina corpus was **deliberately excluded** because it is CC BY-NC, which is incompatible with Apache 2.0.

The v2 filter chain adds a PT-stopword language heuristic, MinHash LSH fuzzy dedup (Jaccard 0.85, 128 permutations, word-trigram shingles), and a PII regex pass for CPF, email, phone, CEP and addresses, on top of the same exact SHA-1 dedup. Because the dataset versions are pinned and the Gutenberg IDs are fixed, the whole build is byte-reproducible: it produces an identical SHA-256 every time.

## Training, in detail

The optimizer is AdamW with betas `(0.9, 0.95)` and `weight_decay 0.1` applied to all parameters (no separate parameter groups), with gradient clipping at `1.0`. The schedule is linear warmup followed by cosine decay to a floor.

```yaml
# configs/maracatu_20m.yaml (the important bits)
learning_rate: 3.0e-4
min_lr: 3.0e-5
warmup_iters: 1000
max_iters: 50000
batch_size: 16
tokens_per_step: 8192   # no gradient accumulation
seed: 42
```

The 80M used `maracatu_80m_lab.yaml`, the RTX 3060 plan (not the A100 variant): `lr 2.5e-4 -> 2.5e-5`, `warmup 4000`, `200k` iters, `batch 8`, the same 8192 tokens per step.

Mixed precision is `torch.amp.autocast` in bf16, on CUDA only. There is **no GradScaler**, because bf16 already has fp32 dynamic range, and the master weights stay fp32. On Ampere this gave about **2.4x throughput**, from 8.5k to 20.2k tokens per second. `torch.compile` is optional.

Checkpointing was built for spot-instance preemption: it is atomic, RNG-complete (so a resume is bit-identical), and dual-triggered, firing every N steps **and** every 30 minutes of wall-clock time. The git commit hash is stamped into every checkpoint, so a weight file always knows which code produced it.

### Hardware and the Chinchilla framing

Maracatu-20M trained on a Kaggle **T4 (15.6GB)** in **5h45min** at roughly 20k tokens per second. Maracatu-80M trained on a self-hosted **NVIDIA RTX 3060 12GB** in **22h31min** of continuous training at about 20,200 tokens per second.

On the Chinchilla axis, the 20M saw about 410M tokens (~24.5 tokens per parameter) and the 80M saw about 1.64B (~21.7 tokens per parameter). Both are deliberately a little above the ~20 optimum, trading a bit of compute for a model that has clearly digested its data.

## The whole loop in four commands

```bash
python scripts/clean_corpus.py                              # build the corpus
python tokenizer/train_tokenizer.py                         # train the tokenizer
python -m maracatu.train --config configs/maracatu_20m.yaml # train the model
python -m maracatu.sample --checkpoint checkpoints/latest.pt --prompt "O Brasil é"
```

Hyperparameters live in YAML configs, so a new run is a new file, not a new branch.

## Evaluation, honestly

Evaluation runs through EleutherAI's `lm-evaluation-harness`, zero-shot, seed 42, with a custom ENEM task added.

| Metric | Maracatu-20M | Maracatu-80M |
| --- | --- | --- |
| Validation perplexity | 23.81 | 21.34 |
| Best val loss | 3.1703 | 3.0604 |
| Belebele PT | 23.78% | - |
| ASSIN Entailment | 27.68% | 29.08% |
| ASSIN Paraphrase | 60.53% | 52.42% |
| ENEM | 19.22% | 20.27% |

Here is the honest read. Nearly every multiple-choice task sits at or below random chance for both models. Only ASSIN Paraphrase is meaningfully above chance. And there is a genuinely odd result: ASSIN Paraphrase **drops** from 60.5% on the 20M to 52.4% on the 80M, even though the larger model has the lower perplexity. I attribute that to harness-version differences and the high variance of MCQ scoring at this scale, not to the bigger model being worse at Portuguese.

The encouraging line is that the 20M (17M parameters) still beats the Tucano-160M baseline on ASSIN Paraphrase and ties it on ENEM. That is the small thesis of the whole project: a curated corpus and a modern architecture pay off at small scale. These are honest baselines published next to their weights, not state-of-the-art claims.

## Why it matters

Most open Portuguese models we use are afterthoughts of English-first training. Building one from scratch, with a legally clean open corpus and open weights, is a small act of sovereignty: it puts the whole recipe in the open where the Brazilian community can inspect, fork and improve it.

The weights are on [Hugging Face](https://huggingface.co/maracatu-labs) and [Ollama](https://ollama.com/whereisanzi). The code is on [GitHub](https://github.com/maracatu-org/maracatu). Pull requests, corpus improvements and new benchmarks are all welcome.
