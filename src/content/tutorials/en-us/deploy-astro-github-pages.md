---
title: "Deploy an Astro site to GitHub Pages"
description: "A minimal GitHub Actions workflow that builds and ships your Astro site on every push."
pubDate: 2026-06-25
lang: "en-us"
tags: ["astro", "ci"]
---

Deploying a static Astro site to GitHub Pages takes one config value and one workflow file. Here's the whole thing.

## 1. Set your site URL

In `astro.config.mjs`, set the `site` option to your Pages URL:

```js
export default defineConfig({
  site: "https://your-user.github.io",
});
```

For a user or organization site (the `your-user.github.io` repo), you don't need a `base`. For a project site, add `base: "/repo-name"`.

## 2. Add the workflow

Create `.github/workflows/deploy.yml`:

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

## 3. Turn on Pages

In your repo settings, open **Pages** and set the source to **GitHub Actions**. Push to `main` and your site goes live in about a minute.

That's the entire pipeline. No build server, no secrets to manage.
