import { getCollection, type CollectionEntry } from "astro:content";
import type { Lang } from "../i18n/ui";

export type Article = CollectionEntry<"articles">;

/** The clean slug for a post, with its `en-us/` or `pt-br/` folder prefix removed. */
export function postSlug(entry: Article): string {
  return entry.id.replace(/^(en-us|pt-br)\//, "");
}

/** Estimate reading time in minutes from the raw markdown body. */
export function readingTime(body: string | undefined): number {
  const words = (body ?? "").trim().split(/\s+/).filter(Boolean).length;
  return Math.max(1, Math.round(words / 200));
}

/** Published, non-draft articles for a language, newest first. */
export async function getArticles(lang: Lang): Promise<Article[]> {
  const all = await getCollection("articles", ({ data }) => {
    const isProd = import.meta.env.PROD;
    return data.lang === lang && (!isProd || !data.draft);
  });
  return all.sort(
    (a, b) => b.data.pubDate.getTime() - a.data.pubDate.getTime(),
  );
}
