---
title: "Treinando o Maracatu-20M: um LLM de português do Brasil do zero"
description: "Por que treinei um modelo de português com 17M de parâmetros do zero, e as escolhas de corpus, tokenizer e arquitetura por trás dele."
pubDate: 2026-06-27
lang: "pt-br"
tags: ["llm", "pytorch", "maracatu"]
---

Maracatu é um projeto open source para pré-treinar modelos de linguagem em português do Brasil, com pesos abertos sob Apache 2.0 e foco em soberania nacional em IA. Os dois primeiros modelos, **Maracatu-20M** (17M de parâmetros) e **Maracatu-80M** (87.8M), são pequenos de propósito. Este post é sobre o menor deles, e por que treinar algo minúsculo do zero ainda vale a pena.

## Por que treinar pequeno

Um modelo de 17M de parâmetros não vai escrever seu código nem passar no Enem. Nunca foi essa a ideia. Modelos pequenos são uma função forçante: toda decisão sobre dados, tokenizer e arquitetura aparece na hora na curva de loss, e você roda um ciclo completo de treino em uma única GPU modesta. Você aprende o pipeline inteiro, de ponta a ponta, em vez de alugar intuição do checkpoint de outra pessoa.

O Maracatu-20M chegou a uma perplexidade de validação de **23.81** na Wikipedia PT (~550M de tokens). O Maracatu-80M, treinado numa mistura maior (Wikipedia + Gutenberg + CulturaX-PT, ~1.6B de tokens), chegou a **21.34**. Esses números não são estado da arte, e não deveriam ser. São baselines honestos para o português, publicados com os pesos para qualquer um reproduzir e superar.

## O corpus que você pode treinar legalmente

A decisão mais subestimada é o que entra. Usei apenas fontes com licença compatível com Apache 2.0:

- **Wikipedia PT**, CC BY-SA: 979 mil artigos, cerca de 550M de tokens BPE.
- **Project Gutenberg**, domínio público: Machado de Assis, José de Alencar e outros clássicos brasileiros.
- **CulturaX-PT**, um subconjunto filtrado para português do Brasil.

Limpar importa tanto quanto coletar. O pipeline de corpus baixa a Wikipedia PT pela biblioteca `datasets`, limpa e escreve um único `corpus.txt`. Lixo no corpus é a forma mais barata de desperdiçar horas de GPU.

## Um tokenizer treinado para o português

Treinei um **tokenizer SentencePiece BPE com vocabulário de 16k** direto no corpus PT-BR, em vez de reaproveitar um vocabulário pensado em inglês primeiro. Um tokenizer afinado para o português gasta menos tokens no mesmo texto, o que significa mais contexto efetivo e treino mais barato para a mesma quantidade de palavras.

## Arquitetura: um Llama pequeno

O modelo é um transformer decoder-only no estilo Llama, com os componentes que viraram padrão:

- RMSNorm
- Rotary position embeddings (RoPE)
- Feed-forward SwiGLU
- Sem bias em `nn.Linear`
- Weight tying entre o embedding e a projeção de saída

Uma escolha rendeu mais que todas as outras: o state dict é **alinhado com o `LlamaForCausalLM` do Hugging Face**. Isso significa que os pesos publicados carregam pelo `transformers` sem script de conversão. Você não precisa saber nada do meu código de treino para usar o modelo.

## O loop inteiro em quatro comandos

O framework é PyTorch, e a base pedagógica é o nanoGPT do Andrej Karpathy. O ciclo completo é pequeno o suficiente para ler:

```bash
python scripts/clean_corpus.py                              # prepara o corpus
python tokenizer/train_tokenizer.py                         # treina o tokenizer
python -m maracatu.train --config configs/maracatu_20m.yaml # treina o modelo
python -m maracatu.sample --checkpoint checkpoints/latest.pt --prompt "O Brasil é"
```

Os hiperparâmetros ficam em configs YAML, então um novo treino é um arquivo novo, não uma branch nova. A avaliação roda contra provas brasileiras (ENEM, ASSIN) pelo `lm-evaluation-harness`.

## Por que isso importa

A maioria dos modelos abertos de português que usamos é um subproduto de treino pensado em inglês primeiro. Construir um do zero, com corpus aberto e pesos abertos, é um pequeno ato de soberania: coloca a receita inteira no aberto, onde a comunidade brasileira pode inspecionar, forkar e melhorar.

Os pesos estão no [Hugging Face](https://huggingface.co/maracatu-labs) e no [Ollama](https://ollama.com/whereisanzi). O código está no [GitHub](https://github.com/maracatu-org/maracatu). Pull requests, melhorias de corpus e novos benchmarks são todos bem-vindos.
