# whereisanzi.github.io

Personal tech blog. Static site built with [Astro](https://astro.build) and Tailwind CSS, bilingual (EN/PT), with dark mode and an RSS feed.

## Develop

```bash
npm install
npm run dev      # http://localhost:4321
```

## Build

```bash
npm run build    # outputs to ./dist
npm run preview  # serve the production build locally
```

## Writing a tutorial

Add a Markdown file under `src/content/tutorials/en/` or `src/content/tutorials/pt/`:

```md
---
title: "My tutorial"
description: "One line summary."
pubDate: 2026-06-27
lang: "en"
tags: ["astro"]
draft: false
---

Content goes here.
```

English posts are served at `/tutorials/<slug>`, Portuguese at `/pt/tutorials/<slug>`.

## Deploy

Every push to `main` triggers `.github/workflows/deploy.yml`, which builds the site
and publishes it to GitHub Pages. Set the Pages source to **GitHub Actions** in the
repository settings.
