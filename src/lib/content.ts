import { getCollection, type CollectionEntry } from "astro:content";
import type { Lang } from "../i18n/ui";

export type Tutorial = CollectionEntry<"tutorials">;

/** The clean slug for a post, with its `en/` or `pt/` folder prefix removed. */
export function postSlug(entry: Tutorial): string {
  return entry.id.replace(/^(en|pt)\//, "");
}

/** Estimate reading time in minutes from the raw markdown body. */
export function readingTime(body: string | undefined): number {
  const words = (body ?? "").trim().split(/\s+/).filter(Boolean).length;
  return Math.max(1, Math.round(words / 200));
}

/** Published, non-draft tutorials for a language, newest first. */
export async function getTutorials(lang: Lang): Promise<Tutorial[]> {
  const all = await getCollection("tutorials", ({ data }) => {
    const isProd = import.meta.env.PROD;
    return data.lang === lang && (!isProd || !data.draft);
  });
  return all.sort(
    (a, b) => b.data.pubDate.getTime() - a.data.pubDate.getTime(),
  );
}
