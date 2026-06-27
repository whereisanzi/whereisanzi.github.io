export const languages = {
  "en-us": "English",
  "pt-br": "Português",
} as const;

export const defaultLang = "en-us";

export type Lang = keyof typeof languages;

export const ui = {
  "en-us": {
    "site.title": "whereisanzi",
    "site.tagline": "breaking things on purpose, writing down why",
    "site.description":
      "Articles and notes on training small LLMs, low-level systems and civic AI, from Brazil.",
    "nav.home": "Home",
    "nav.articles": "Articles",
    "nav.about": "About",
    "home.latest": "Latest articles",
    "home.intro":
      "Hey, I'm anzi. I engineer systems from the metal up and train small language models. I write here about building open-weight LLMs, low-level systems in Rust and civic AI, from Brazil.",
    "home.viewAll": "View all articles",
    "articles.title": "Articles",
    "articles.subtitle": "Everything I've written, newest first.",
    "articles.empty": "No articles yet, check back soon.",
    "articles.readMore": "Read more",
    "about.title": "About",
    "post.back": "Back to articles",
    "post.publishedOn": "Published on",
    "post.minRead": "min read",
    "theme.toggle": "Toggle dark mode",
    "lang.switch": "Switch language",
    "footer.builtWith": "Built with Astro. Source on",
    "notfound.title": "Page not found",
    "notfound.text": "The page you're looking for doesn't exist.",
    "notfound.home": "Go home",
  },
  "pt-br": {
    "site.title": "whereisanzi",
    "site.tagline": "quebrando coisas de propósito, e anotando o porquê",
    "site.description":
      "Artigos e anotações sobre treinar LLMs pequenos, sistemas de baixo nível e IA cívica, daqui do Brasil.",
    "nav.home": "Início",
    "nav.articles": "Artigos",
    "nav.about": "Sobre",
    "home.latest": "Artigos recentes",
    "home.intro":
      "Olá, eu sou o anzi. Construo sistemas desde o metal e treino modelos de linguagem pequenos. Escrevo aqui sobre LLMs de pesos abertos, sistemas de baixo nível em Rust e IA cívica, daqui do Brasil.",
    "home.viewAll": "Ver todos os artigos",
    "articles.title": "Artigos",
    "articles.subtitle": "Tudo que escrevi, do mais novo ao mais antigo.",
    "articles.empty": "Ainda não há artigos, volte em breve.",
    "articles.readMore": "Ler mais",
    "about.title": "Sobre",
    "post.back": "Voltar aos artigos",
    "post.publishedOn": "Publicado em",
    "post.minRead": "min de leitura",
    "theme.toggle": "Alternar modo escuro",
    "lang.switch": "Trocar idioma",
    "footer.builtWith": "Feito com Astro. Código em",
    "notfound.title": "Página não encontrada",
    "notfound.text": "A página que você procura não existe.",
    "notfound.home": "Ir para o início",
  },
} as const;
