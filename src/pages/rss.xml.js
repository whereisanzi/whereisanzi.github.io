import rss from "@astrojs/rss";
import { getCollection } from "astro:content";

export async function GET(context) {
  const all = await getCollection("tutorials", ({ data }) => !data.draft);
  const items = all
    .sort((a, b) => b.data.pubDate.getTime() - a.data.pubDate.getTime())
    .map((post) => {
      const slug = post.id.replace(/^(en|pt)\//, "");
      const prefix = post.data.lang === "pt" ? "/pt" : "";
      return {
        title: post.data.title,
        description: post.data.description,
        pubDate: post.data.pubDate,
        link: `${prefix}/tutorials/${slug}/`,
        categories: post.data.tags,
      };
    });

  return rss({
    title: "whereisanzi · yet another tech blog",
    description:
      "Tutorials, notes and write-ups on software, web and whatever I'm learning.",
    site: context.site,
    items,
  });
}
