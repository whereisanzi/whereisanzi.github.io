export const languages = {
  "en-us": "English",
  "pt-br": "Português",
} as const;

export const defaultLang = "en-us";

export type Lang = keyof typeof languages;

export const ui = {
  "en-us": {
    "site.title": "whereisanzi",
    "site.tagline": "yet another tech blog",
    "site.description":
      "Tutorials, notes and write-ups on software, web and whatever I'm learning.",
    "nav.home": "Home",
    "nav.tutorials": "Tutorials",
    "nav.about": "About",
    "home.latest": "Latest tutorials",
    "home.intro":
      "Hey, I'm Anzi. I write tutorials and notes about software engineering, the web and the things I break along the way.",
    "home.viewAll": "View all tutorials",
    "tutorials.title": "Tutorials",
    "tutorials.subtitle": "Everything I've written, newest first.",
    "tutorials.empty": "No tutorials yet, check back soon.",
    "tutorials.readMore": "Read more",
    "about.title": "About",
    "post.back": "Back to tutorials",
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
    "site.tagline": "mais um blog de tecnologia",
    "site.description":
      "Tutoriais, anotações e write-ups sobre software, web e o que eu estiver aprendendo.",
    "nav.home": "Início",
    "nav.tutorials": "Tutoriais",
    "nav.about": "Sobre",
    "home.latest": "Tutoriais recentes",
    "home.intro":
      "Olá, eu sou o Anzi. Escrevo tutoriais e anotações sobre engenharia de software, web e as coisas que quebro pelo caminho.",
    "home.viewAll": "Ver todos os tutoriais",
    "tutorials.title": "Tutoriais",
    "tutorials.subtitle": "Tudo que escrevi, do mais novo ao mais antigo.",
    "tutorials.empty": "Ainda não há tutoriais, volte em breve.",
    "tutorials.readMore": "Ler mais",
    "about.title": "Sobre",
    "post.back": "Voltar aos tutoriais",
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
