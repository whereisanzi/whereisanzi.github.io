import { ui, defaultLang, languages, type Lang } from "./ui";

/** Detect the active language from the current URL pathname. */
export function getLangFromUrl(url: URL): Lang {
  const [, maybeLang] = url.pathname.split("/");
  if (maybeLang in languages) return maybeLang as Lang;
  return defaultLang;
}

/** Returns a translation function `t("key")` bound to the given language. */
export function useTranslations(lang: Lang) {
  return function t(key: keyof (typeof ui)[typeof defaultLang]): string {
    return ui[lang][key] ?? ui[defaultLang][key];
  };
}

/** Build a locale-aware path. Every locale is prefixed (e.g. /en-us/..., /pt-br/...). */
export function localizedPath(path: string, lang: Lang): string {
  const clean = "/" + path.replace(/^\/+|\/+$/g, "");
  const normalized = clean === "/" ? "" : clean;
  return `/${lang}${normalized}` || "/";
}

/** Strip the locale prefix from a pathname, returning the bare route. */
export function stripLangFromPath(pathname: string): string {
  const parts = pathname.split("/").filter(Boolean);
  if (parts[0] && parts[0] in languages) {
    parts.shift();
  }
  return "/" + parts.join("/");
}

/** Format a date according to the active language. */
export function formatDate(date: Date, lang: Lang): string {
  return new Intl.DateTimeFormat(lang, {
    year: "numeric",
    month: "long",
    day: "numeric",
  }).format(date);
}
