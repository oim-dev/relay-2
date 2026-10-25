import {
  AppWindow,
  FileText,
  Files,
  Flag,
  Rocket,
  Sparkles,
  History,
  LayoutDashboard,
  ChartNoAxesCombined,
  Workflow,
  Boxes,
} from "lucide-react";

/**
 * Доступные разделы текущих Contracts/Core в порядке рабочего сценария.
 */
export const NAVIGATION = [
  { path: "", label: "Обзор", Icon: ChartNoAxesCombined },
  { path: "knowledge/product", label: "Паспорт продукта", Icon: FileText },
  { path: "knowledge/feature", label: "Возможности", Icon: Sparkles },
  { path: "knowledge/scenario", label: "Сценарии", Icon: Workflow },
  { path: "knowledge/application", label: "Приложения", Icon: AppWindow },
  { path: "knowledge/implementation", label: "Реализации", Icon: Boxes },
  { path: "board", label: "Доски и задачи", Icon: LayoutDashboard },
  { path: "plans", label: "Планы", Icon: Flag },
  { path: "releases", label: "Релизы", Icon: Rocket },
  { path: "documents", label: "Библиотека знаний", Icon: Files },
  { path: "history", label: "История работы", Icon: History },
] as const;
