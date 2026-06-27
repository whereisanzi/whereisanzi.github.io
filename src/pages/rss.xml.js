import rss from "@astrojs/rss";
import { getCollection } from "astro:content";

export async function GET(context) {
  const all = await getCollection("articles", ({ data }) => !data.draft);
  const items = all
    .sort((a, b) => b.data.pubDate.getTime() - a.data.pubDate.getTime())
    .map((post) => {
      const slug = post.id.replace(/^(en-us|pt-br)\//, "");
      return {
        title: post.data.title,
        description: post.data.description,
        pubDate: post.data.pubDate,
        link: `/${post.data.lang}/articles/${slug}/`,
        categories: post.data.tags,
      };
    });

  return rss({
    title: "whereisanzi · breaking things on purpose, writing down why",
    description:
      "Articles, notes and write-ups on software, web and whatever I'm learning.",
    site: context.site,
    items,
  });
}
