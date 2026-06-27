---
title: "Treinando o Maracatu-20M: um LLM de português do Brasil do zero"
description: "Um modelo pequeno no estilo Llama treinado sobre um corpus de português legalmente limpo, com a arquitetura, o loop de treino e os benchmarks honestos por trás dele."
pubDate: 2026-06-27
lang: "pt-br"
tags: ["llm", "pytorch", "maracatu"]
---

Maracatu é um projeto open source para pré-treinar modelos de linguagem em português do Brasil, com pesos abertos sob Apache 2.0 e foco em soberania em IA. Os dois primeiros modelos, **Maracatu-20M** e **Maracatu-80M**, são pequenos de propósito. Este post é principalmente sobre o menor deles, com o modelo de 80M como contraponto para mostrar o que muda quando você escala um pouco.

Quero ser honesto já no primeiro parágrafo: são modelos minúsculos, e na maioria dos benchmarks de múltipla escolha eles ficam no nível do acaso ou abaixo dele. Isso não é uma falha para esconder, é justamente o motivo de publicar baselines. O que aprendi construindo o pipeline vale muito mais que qualquer linha de leaderboard.

## Por que treinar pequeno

Um modelo de 17M de parâmetros não vai escrever seu código nem passar no Enem. Modelos pequenos são uma função forçante: toda decisão sobre dados, tokenizer e arquitetura aparece na hora na curva de loss, e um ciclo completo de treino cabe numa única GPU modesta. Você aprende o pipeline inteiro, de ponta a ponta, em vez de alugar intuição do checkpoint de outra pessoa.

O Maracatu-20M tem **16,77M de parâmetros no total** (10,62M deles fora da tabela de embeddings). O Maracatu-80M tem **87,80M no total** (75,52M fora dos embeddings). Esta é a forma completa dos dois:

| Config | 20M | 80M |
| --- | --- | --- |
| Camadas | 6 | 12 |
| Hidden size | 384 | 768 |
| Cabeças de atenção | 6 | 12 |
| Cabeças KV | 6 (sem GQA) | 4 (GQA 3:1) |
| Head dim | 64 | 64 |
| Intermediate (SwiGLU) | 1024 | 2048 |
| Contexto | 512 | 1024 |
| Vocab | 16000 | 16000 |

O treino do 80M é a primeira vez que o projeto usou grouped-query attention num treino de verdade, seguindo o padrão 3:1 do Llama-3, e rodou sem nenhuma instabilidade de loss.

## Arquitetura: um Llama pequeno, não um GPT-2 pequeno

As pessoas presumem que "treinado do zero no espírito do nanoGPT" significa um clone de GPT-2. O **loop** de treino é inspirado no nanoGPT do Karpathy, mas a **arquitetura** é claramente no estilo Llama. Essa distinção é o projeto inteiro. A implementação está em `src/maracatu/model.py`:

- **RMSNorm**, sem bias. Faz cast para fp32, calcula `variance = x.pow(2).mean(-1)`, depois `x * rsqrt(variance + eps)` com `eps = 1e-5`.
- **RoPE** na convenção rotate-half do Hugging Face, com `inv_freq = 1 / (theta ** (arange(0, head_dim, 2) / head_dim))` e `rope_theta = 10000`. As frequências ficam em cache como **buffers não persistentes**, então nunca entram no state dict. Esse detalhe importa para o carregamento limpo no Hugging Face mais adiante.
- **Atenção** com `q_proj`, `k_proj`, `v_proj` e `o_proj` separados, todos `bias=False`. O GQA é feito com `repeat_interleave` nas cabeças KV, e a atenção em si é `F.scaled_dot_product_attention(is_causal=True)`. Em CUDA, o SDPA do PyTorch despacha sozinho para os kernels do FlashAttention, então não há dependência de `flash-attn`.
- **MLP SwiGLU**: `down_proj(F.silu(gate_proj(x)) * up_proj(x))`, de novo `bias=False`.
- **Camadas decoder pre-norm** e **weight tying**, onde `lm_head.weight` é o mesmo tensor de `embed_tokens.weight`.

A inicialização é `normal_(0, 0.02)`, com uma herança explícita do nanoGPT: a re-inicialização escalada pelo residual, no estilo GPT-2, de `o_proj` e `down_proj` para `std = 0.02 / sqrt(2 * num_layers)`. Isso evita que o residual stream exploda conforme a profundidade cresce.

## O state dict do Hugging Face, por construção

Esse é o ganho técnico mais limpo do projeto, então merece seção própria. O script de export `scripts/export_hf.py` não converte nada: cada nome de parâmetro é **escrito desde o início** para bater exatamente com o Llama do HF. Então você tem `model.embed_tokens`, `model.layers[i].self_attn.{q,k,v,o}_proj`, `mlp.{gate,up,down}_proj`, `input_layernorm`, `post_attention_layernorm`, `model.norm` e `lm_head`, sem nenhuma tabela de remapeamento.

O export faz só as pequenas coisas honestas:

- remove o prefixo `_orig_mod.` que o `torch.compile` adiciona;
- se `tie_word_embeddings` está ligado, apaga `lm_head.weight` para o HF re-amarrar;
- `load_state_dict(strict=False)`, porque os buffers de RoPE são não persistentes e simplesmente não estão lá.

Um passo de `verify_equivalence` alimenta os mesmos ids aleatórios de tokens para a implementação do Maracatu e para a do `transformers` e exige `max_abs_diff <= 1e-3`. Os modelos publicados validaram com `max_abs_diff = 0.0`. O `config.json` declara `architectures: ["LlamaForCausalLM"]`, então os pesos carregam pelo `transformers` sem script de conversão e sem surpresas.

## Um tokenizer feito para o português

Treinei um **tokenizer SentencePiece BPE** direto no corpus (`tokenizer/train_tokenizer.py`): `model_type bpe`, `vocab_size 16000`, `character_coverage 0.9995`, `split_digits`, `byte_fallback` e `remove_extra_whitespaces`. Os tokens especiais são `pad=0 <pad>`, `unk=1 <unk>`, `bos=2 <s>`, `eos=3 </s>`.

Uma escolha é uma limitação real e documentada: a regra de normalização é `nmt_nfkc_cf`, que é NFKC mais casefold. Isso torna o modelo **só minúsculas**. Simplifica o vocabulário e ajuda um modelo minúsculo, mas significa que a informação de maiúsculas desaparece antes mesmo do treino começar. Prefiro registrar isso a fingir que é um recurso.

O data loader tokeniza o corpus inteiro num único arquivo `.npy` `uint16`, acrescenta `</s>` depois de cada linha, e usa um split cronológico de cauda para validação (os últimos 0,5% do corpus são o holdout). O treino lê janelas contíguas aleatórias de `context_size` do array.

## O corpus que você pode treinar legalmente

A decisão mais subestimada é o que entra. Usei apenas fontes com licença compatível com Apache 2.0, e documentei exatamente o que ficou de fora.

O **corpus v1 (para o modelo de 20M)** é o `wikimedia/wikipedia`, config `20231101.pt`. A cadeia de filtros descarta documentos com menos de 200 caracteres, descarta linhas com menos de 30 caracteres, descarta linhas só de símbolos ou números, normaliza espaços em branco e faz dedup exato de linhas por SHA-1. O resultado são **979.492 artigos**, cerca de **599M de tokens BPE** depois da tokenização. O modelo viu aproximadamente **410M de tokens** ao longo de 50k passos, cerca de 0,75 de uma época.

O **corpus v2 (para o modelo de 80M)** mantém o mesmo dump da Wikipedia e adiciona duas fontes: Project Gutenberg PT (24 obras de domínio público fixas no código, de Machado de Assis, José de Alencar, Aluísio Azevedo, Eça de Queirós, Graciliano Ramos, Lima Barreto e outros, baixadas a 1 requisição por segundo com os cabeçalhos removidos) e CulturaX-PT (`uonlp/CulturaX`, config `pt`, ODC-BY, lido em streaming). O total é cerca de **1,60B de tokens**. O corpus Carolina foi **deliberadamente excluído** porque é CC BY-NC, incompatível com a Apache 2.0.

A cadeia de filtros do v2 acrescenta uma heurística de idioma por stopwords do português, dedup fuzzy com MinHash LSH (Jaccard 0,85, 128 permutações, shingles de trigramas de palavras) e uma passada de regex de PII para CPF, email, telefone, CEP e endereços, em cima do mesmo dedup exato por SHA-1. Como as versões dos datasets estão fixadas e os IDs do Gutenberg são fixos, o build inteiro é byte-reprodutível: produz o mesmo SHA-256 toda vez.

## O treino, em detalhe

O otimizador é AdamW com betas `(0.9, 0.95)` e `weight_decay 0.1` aplicado a todos os parâmetros (sem grupos separados), com clipping de gradiente em `1.0`. O schedule é warmup linear seguido de cosine decay até um piso.

```yaml
# configs/maracatu_20m.yaml (as partes importantes)
learning_rate: 3.0e-4
min_lr: 3.0e-5
warmup_iters: 1000
max_iters: 50000
batch_size: 16
tokens_per_step: 8192   # sem acumulação de gradiente
seed: 42
```

O 80M usou o `maracatu_80m_lab.yaml`, o plano da RTX 3060 (não a variante de A100): `lr 2.5e-4 -> 2.5e-5`, `warmup 4000`, `200k` iterações, `batch 8`, os mesmos 8192 tokens por passo.

A precisão mista é `torch.amp.autocast` em bf16, só em CUDA. **Não há GradScaler**, porque bf16 já tem a faixa dinâmica do fp32, e os pesos mestres ficam em fp32. Em Ampere isso deu cerca de **2,4x de throughput**, de 8,5k para 20,2k tokens por segundo. O `torch.compile` é opcional.

O checkpointing foi feito para preempção de instância spot: é atômico, completo em RNG (então um resume é bit a bit idêntico) e tem gatilho duplo, disparando a cada N passos **e** a cada 30 minutos de relógio. O hash do commit git é carimbado em cada checkpoint, então um arquivo de pesos sempre sabe qual código o produziu.

### Hardware e o enquadramento Chinchilla

O Maracatu-20M treinou numa **T4 (15,6GB)** do Kaggle em **5h45min** a cerca de 20k tokens por segundo. O Maracatu-80M treinou numa **NVIDIA RTX 3060 12GB** auto-hospedada em **22h31min** de treino contínuo, a cerca de 20.200 tokens por segundo.

No eixo Chinchilla, o 20M viu cerca de 410M de tokens (~24,5 tokens por parâmetro) e o 80M viu cerca de 1,64B (~21,7 tokens por parâmetro). Os dois ficam de propósito um pouco acima do ótimo de ~20, trocando um pouco de compute por um modelo que claramente digeriu seus dados.

## O loop inteiro em quatro comandos

```bash
python scripts/clean_corpus.py                              # monta o corpus
python tokenizer/train_tokenizer.py                         # treina o tokenizer
python -m maracatu.train --config configs/maracatu_20m.yaml # treina o modelo
python -m maracatu.sample --checkpoint checkpoints/latest.pt --prompt "O Brasil é"
```

Os hiperparâmetros ficam em configs YAML, então um novo treino é um arquivo novo, não uma branch nova.

## Avaliação, honestamente

A avaliação roda pelo `lm-evaluation-harness` da EleutherAI, zero-shot, seed 42, com uma tarefa custom de ENEM adicionada.

| Métrica | Maracatu-20M | Maracatu-80M |
| --- | --- | --- |
| Perplexidade de validação | 23,81 | 21,34 |
| Melhor val loss | 3,1703 | 3,0604 |
| Belebele PT | 23,78% | - |
| ASSIN Entailment | 27,68% | 29,08% |
| ASSIN Paraphrase | 60,53% | 52,42% |
| ENEM | 19,22% | 20,27% |

A leitura honesta é esta. Quase toda tarefa de múltipla escolha fica no nível do acaso ou abaixo para os dois modelos. Só o ASSIN Paraphrase está significativamente acima do acaso. E há um resultado genuinamente estranho: o ASSIN Paraphrase **cai** de 60,5% no 20M para 52,4% no 80M, mesmo o modelo maior tendo a perplexidade menor. Atribuo isso a diferenças de versão do harness e à alta variância da pontuação de múltipla escolha nessa escala, não ao modelo maior ser pior em português.

A linha animadora é que o 20M (17M de parâmetros) ainda supera o baseline Tucano-160M no ASSIN Paraphrase e empata com ele no ENEM. Essa é a pequena tese do projeto inteiro: um corpus curado e uma arquitetura moderna rendem em escala pequena. São baselines honestos publicados ao lado dos pesos, não alegações de estado da arte.

## Por que isso importa

A maioria dos modelos abertos de português que usamos é um subproduto de treino pensado em inglês primeiro. Construir um do zero, com um corpus aberto e legalmente limpo e pesos abertos, é um pequeno ato de soberania: coloca a receita inteira no aberto, onde a comunidade brasileira pode inspecionar, forkar e melhorar.

Os pesos estão no [Hugging Face](https://huggingface.co/maracatu-labs) e no [Ollama](https://ollama.com/whereisanzi). O código está no [GitHub](https://github.com/maracatu-org/maracatu). Pull requests, melhorias de corpus e novos benchmarks são todos bem-vindos.
