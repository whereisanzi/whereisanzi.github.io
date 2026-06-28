// @ts-check
import { defineConfig } from "astro/config";
import sitemap from "@astrojs/sitemap";
import tailwindcss from "@tailwindcss/vite";

// https://astro.build/config
export default defineConfig({
  site: "https://whereisanzi.github.io",
  integrations: [sitemap()],
  markdown: {
    shikiConfig: {
      // Dual themes: light and dark vars are emitted, CSS switches them with
      // the `.dark` class on <html> (see src/styles/global.css).
      themes: {
        light: "vitesse-light",
        dark: "vitesse-dark",
      },
      defaultColor: false,
      wrap: false,
    },
  },
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
