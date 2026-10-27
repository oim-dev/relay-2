import { Link, useLocation, useSearchParams } from "react-router-dom";
import { useProductRoute } from "compositions/widgets/product-page";
import { findProductEntry, ProductKey } from "domains/product";
import { Button } from "@mantine/core";
import { useProductDemo } from "domains/product-demo";
import { getProductReturn, ProductPage, useProductPath } from "compositions/widgets/product-page";
import { StatePanel } from "ui/state-panel";
import { ApplicationScopeForm } from "./ui/application-scope-form";

/**
 * Связывает приложение с редактором его состава реализации.
 *
 * Используется для:
 *  - настройки выбранных фич, сценариев и описаний вклада в области приложения
 */
export const ProductApplicationScopeScreen = () => {
  const { applicationId } = useProductRoute();
  const { snapshot } = useProductDemo();
  const base = useProductPath();
  const location = useLocation();
  const [searchParams] = useSearchParams();
  const application = snapshot.applications.find((entry) => entry.id === applicationId);
  if (application === undefined)
    return (
      <StatePanel
        title="Приложение не найдено"
        description="Откройте настройку из списка приложений."
        action={
          <Button component={Link} to={`${base}/applications`}>
            К приложениям
          </Button>
        }
      />
    );
  const backTo = getProductReturn(
    location.state,
    `${base}/applications/${application.id}#application-features`,
    base,
  );
  const contributions = snapshot.contributions.filter(
    (entry) => entry.applicationId === application.id,
  );
  const draftScope = `${snapshot.epoch}:application-scope:${application.id}`;
  return (
    <ProductPage
      title={`Реализация: ${application.name}`}
      description="Выберите фичи и сценарии, затем опишите, что приложение должно обеспечить в каждом из них."
      eyebrow="ПРОДУКТ / ПРИЛОЖЕНИЕ"
      backTo={backTo}
      backLabel="К приложению"
      meta={<ProductKey value={application.key} copyable />}
    >
      <ApplicationScopeForm
        key={draftScope}
        application={application}
        features={snapshot.features}
        contributions={contributions}
        revision={snapshot.revision}
        draftScope={draftScope}
        backTo={backTo}
        initialFeatureId={
          findProductEntry(snapshot.features, searchParams.get("feature") ?? undefined)?.id
        }
        initialScenarioId={
          findProductEntry(
            snapshot.features.flatMap((entry) => entry.scenarios),
            searchParams.get("scenario") ?? undefined,
          )?.id
        }
      />
    </ProductPage>
  );
};
