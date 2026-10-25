import { createContext } from "react";
import type { ComponentPropsWithoutRef, ComponentType } from "react";

/** Без настройки ссылки сохраняют обычное поведение браузера. */
export const MarkdownLinkContext = createContext<
  ComponentType<ComponentPropsWithoutRef<"a">> | "a"
>("a");
