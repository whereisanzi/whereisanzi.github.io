---
title: "Hello, world"
description: "Why this blog exists and what you can expect to find here."
pubDate: 2026-06-20
lang: "en-us"
tags: ["meta"]
---

Welcome to **whereisanzi**, yet another tech blog.

I built this to have a calm place to write down what I learn while building software. No newsletters, no popups, just notes and tutorials.

## What you'll find here

- Short, practical tutorials I wish I had found when I was stuck.
- Notes on tools, languages and patterns I use day to day.
- The occasional write-up of something I broke and how I fixed it.

## How it's built

This site is a static site made with [Astro](https://astro.build) and Tailwind CSS. Posts are plain Markdown files, it ships zero JavaScript by default, and it deploys to GitHub Pages automatically on every push.

```js
// every post is just a markdown file with frontmatter
const post = {
  title: "Hello, world",
  lang: "en-us",
  tags: ["meta"],
};
```

That's it. See you in the next one.
