import { StatePanel } from "ui/state-panel";

/**
 * Показывает статус раздела инфраструктуры проекта.
 *
 * Используется для:
 *  - перехода к разрабатываемому разделу из навигации
 */
export const InfrastructureScreen = () => (
  <StatePanel title="Инфраструктура" titleAs="h1" description="В разработке" />
);
