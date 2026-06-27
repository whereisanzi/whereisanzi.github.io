// @ts-check
import { defineConfig } from "astro/config";
import sitemap from "@astrojs/sitemap";
import tailwindcss from "@tailwindcss/vite";

// https://astro.build/config
export default defineConfig({
  site: "https://whereisanzi.github.io",
  integrations: [sitemap()],
  redirects: {
    "/": "/en-us/",
  },
  i18n: {
    locales: ["en-us", "pt-br"],
    defaultLocale: "en-us",
    routing: {
      prefixDefaultLocale: true,
      redirectToDefaultLocale: true,
    },
  },
  vite: {
    plugins: [tailwindcss()],
  },
});
