---
title: "Deploy de um site Astro no GitHub Pages"
description: "Um workflow mínimo do GitHub Actions que builda e publica seu site Astro a cada push."
pubDate: 2026-06-25
lang: "pt"
tags: ["astro", "ci"]
---

Publicar um site estático em Astro no GitHub Pages exige um valor de configuração e um arquivo de workflow. Aqui está tudo.

## 1. Defina a URL do site

No `astro.config.mjs`, configure a opção `site` com a URL do seu Pages:

```js
export default defineConfig({
  site: "https://seu-usuario.github.io",
});
```

Para um site de usuário ou organização (o repositório `seu-usuario.github.io`), você não precisa de `base`. Para um site de projeto, adicione `base: "/nome-do-repo"`.

## 2. Adicione o workflow

Crie o arquivo `.github/workflows/deploy.yml`:

```yaml
name: Deploy to GitHub Pages
on:
  push:
    branches: [main]
permissions:
  contents: read
  pages: write
  id-token: write
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: withastro/action@v3
  deploy:
    needs: build
    runs-on: ubuntu-latest
    environment:
      name: github-pages
    steps:
      - uses: actions/deploy-pages@v4
```

## 3. Ative o Pages

Nas configurações do repositório, abra **Pages** e defina a origem como **GitHub Actions**. Faça push para a `main` e o site fica no ar em cerca de um minuto.

Esse é o pipeline inteiro. Sem servidor de build, sem segredos para gerenciar.
