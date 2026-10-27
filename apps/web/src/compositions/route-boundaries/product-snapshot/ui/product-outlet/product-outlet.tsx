import { Alert, Button } from "@mantine/core";
import { Navigate, Outlet, useLocation } from "react-router-dom";
import { useProductDemo } from "domains/product-demo";
import { findProductEntry, useProductEntity, productError } from "domains/product";
import { useProjectBasePath, useProjectId } from "domains/project";
import { StatePanel } from "ui/state-panel";

/**
 * Различает состояния чтения продукта и открывает выбранный подраздел.
 *
 * Используется для:
 *  - проверки загрузки, ошибки чтения и восстановления данных
 */
export const ProductOutlet = () => {
  const { mode, notice, setMode, snapshot } = useProductDemo();
  const location = useLocation();
  const base = `${useProjectBasePath()}/product`;
  const isProductRoute = location.pathname.startsWith(`${base}/`);
  const parts = isProductRoute ? location.pathname.slice(base.length + 1).split("/") : [];
  const collection = parts[0];
  const ref = parts[1];
  const projectId = useProjectId();
  const isAddress =
    (collection === "features" || collection === "applications") &&
    ref !== undefined &&
    ref !== "new";
  const address = useProductEntity(projectId, isAddress ? decodeURIComponent(ref) : null);
  const scenarioRef =
    collection === "features" && parts[2] === "scenarios" && parts[3] !== "new"
      ? parts[3]
      : undefined;
  const scenarioAddress = useProductEntity(
    projectId,
    scenarioRef === undefined ? null : decodeURIComponent(scenarioRef),
  );
  const loadingTitle = isProductRoute ? "Загружаем продукт" : "Загружаем документы";
  const loadingDescription = isProductRoute
    ? "Собираем паспорт, фичи и приложения."
    : "Собираем библиотеку документов проекта.";
  const errorTitle = isProductRoute
    ? "Не удалось прочитать продукт"
    : "Не удалось прочитать документы";
  const hasNotice = notice !== "";
  if (
    mode === "loading" ||
    (isAddress && address.isLoading) ||
    (scenarioRef !== undefined && scenarioAddress.isLoading)
  )
    return <StatePanel isLoading title={loadingTitle} description={loadingDescription} />;
  if (mode === "read-error")
    return (
      <StatePanel
        title={errorTitle}
        description="Проверьте соединение с сервером. Несохранённый ввод остаётся в черновике."
        action={<Button onClick={() => setMode("filled")}>Повторить загрузку</Button>}
      />
    );
  if (
    (address.error && address.data === undefined) ||
    (scenarioAddress.error && scenarioAddress.data === undefined)
  )
    return (
      <StatePanel
        title="Не удалось разрешить адрес"
        description={productError(address.error ?? scenarioAddress.error)}
      />
    );
  const targets =
    collection === "features"
      ? snapshot.features
      : collection === "applications"
        ? snapshot.applications
        : [];
  const matches = targets.filter((entry) => entry.key !== undefined && entry.key === ref);
  const isAmbiguous = matches.length > 1 && !targets.some((entry) => entry.id === ref);
  if (isAmbiguous)
    return (
      <StatePanel
        title="Ключ используется несколькими записями"
        description="Откройте нужную запись по ID и назначьте ей свободный ключ."
      />
    );
  const selected = findProductEntry<{ id: string; key?: string }>(targets, address.data?.id ?? ref);
  if (selected !== undefined) parts[1] = selected.id;
  const feature = snapshot.features.find((entry) => entry.id === selected?.id);
  if (feature !== undefined && location.hash.startsWith("#scenario-")) {
    const scenario = findProductEntry(feature.scenarios, location.hash.slice("#scenario-".length));
    if (scenario !== undefined)
      return (
        <Navigate
          to={`${base}/features/${feature.id}/scenarios/${scenario.id}${location.search}`}
          state={location.state}
          replace
        />
      );
  }
  if (feature !== undefined && parts[2] === "scenarios") {
    const scenario = findProductEntry(feature.scenarios, scenarioAddress.data?.id ?? parts[3]);
    if (scenario !== undefined) parts[3] = scenario.id;
  }
  const canonical = isProductRoute ? `${base}/${parts.join("/")}` : location.pathname;
  if (canonical !== location.pathname)
    return (
      <Navigate
        to={`${canonical}${location.search}${location.hash}`}
        state={location.state}
        replace
      />
    );
  return (
    <>
      {hasNotice && (
        <Alert color="orange" title="Проверьте актуальность реализации" m="lg">
          {notice}
        </Alert>
      )}
      <Outlet />
    </>
  );
};
