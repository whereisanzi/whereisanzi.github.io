import { ui, defaultLang, type Lang } from "./ui";

/** Detect the active language from the current URL pathname. */
export function getLangFromUrl(url: URL): Lang {
  const [, maybeLang] = url.pathname.split("/");
  if (maybeLang in ui) return maybeLang as Lang;
  return defaultLang;
}

/** Returns a translation function `t("key")` bound to the given language. */
export function useTranslations(lang: Lang) {
  return function t(key: keyof (typeof ui)[typeof defaultLang]): string {
    return ui[lang][key] ?? ui[defaultLang][key];
  };
}

/**
 * Build a locale-aware path. The default locale (en) lives at the root,
 * every other locale is prefixed (e.g. /pt/...).
 */
export function localizedPath(path: string, lang: Lang): string {
  const clean = "/" + path.replace(/^\/+|\/+$/g, "");
  const normalized = clean === "/" ? "" : clean;
  return lang === defaultLang ? normalized || "/" : `/${lang}${normalized}`;
}

/** Strip the locale prefix from a pathname, returning the bare route. */
export function stripLangFromPath(pathname: string): string {
  const parts = pathname.split("/").filter(Boolean);
  if (parts[0] && parts[0] in ui && parts[0] !== defaultLang) {
    parts.shift();
  }
  return "/" + parts.join("/");
}

/** Format a date according to the active language. */
export function formatDate(date: Date, lang: Lang): string {
  return new Intl.DateTimeFormat(lang === "pt" ? "pt-BR" : "en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
  }).format(date);
}
