import { useProjectId } from "domains/project";
import { ProductDemoProvider } from "domains/product-demo";
import { ProductOutlet } from "./ui/product-outlet";

/**
 * Подключает полный продуктовый снимок только страницам, которым он необходим.
 *
 * Используется для:
 *  - каталогов, агрегированных страниц и редакторов продукта
 */
export const ProductSnapshotBoundary = () => {
  const projectId = useProjectId();
  return (
    <ProductDemoProvider key={projectId} scopeId={projectId}>
      <ProductOutlet />
    </ProductDemoProvider>
  );
};
