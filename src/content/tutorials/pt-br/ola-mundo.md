---
title: "Olá, mundo"
description: "Por que este blog existe e o que você vai encontrar por aqui."
pubDate: 2026-06-20
lang: "pt-br"
tags: ["meta"]
---

Bem-vindo ao **whereisanzi**, mais um blog de tecnologia.

Criei este espaço para ter um lugar tranquilo onde anotar o que aprendo construindo software. Sem newsletter, sem popup, só notas e tutoriais.

## O que você encontra aqui

- Tutoriais curtos e práticos que eu queria ter achado quando travei.
- Anotações sobre ferramentas, linguagens e padrões que uso no dia a dia.
- De vez em quando, o relato de algo que quebrei e como consertei.

## Como ele é feito

Este site é estático, feito com [Astro](https://astro.build) e Tailwind CSS. Os posts são arquivos Markdown simples, ele entrega zero JavaScript por padrão e faz deploy no GitHub Pages automaticamente a cada push.

```js
// cada post é só um arquivo markdown com frontmatter
const post = {
  title: "Olá, mundo",
  lang: "pt-br",
  tags: ["meta"],
};
```

É isso. Até o próximo.
