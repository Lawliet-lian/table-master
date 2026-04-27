import { en, type Dict } from "./en";
import { zh } from "./zh";

export type LangKey = keyof Dict;
export type LangChoice = "auto" | "en" | "zh";

let active: Dict = en;

export function setLanguage(choice: LangChoice): void {
  if (choice === "zh") {
    active = zh;
    return;
  }
  if (choice === "en") {
    active = en;
    return;
  }
  // auto: detect from window.moment locale or navigator.language
  const lang = detectObsidianLocale();
  active = lang.startsWith("zh") ? zh : en;
}

function detectObsidianLocale(): string {
  // Obsidian exposes the locale via window.moment.locale()
  // Fall back to browser language.
  const w = typeof window !== "undefined" ? (window as unknown as { moment?: { locale?: () => string } }) : undefined;
  if (w?.moment?.locale) {
    try {
      return w.moment.locale() ?? "en";
    } catch {
      // ignore
    }
  }
  if (typeof navigator !== "undefined" && navigator.language) return navigator.language.toLowerCase();
  return "en";
}

export function t(key: LangKey, params?: Record<string, string>): string {
  let s = active[key] ?? en[key] ?? key;
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      s = s.replaceAll(`{${k}}`, v);
    }
  }
  return s;
}
