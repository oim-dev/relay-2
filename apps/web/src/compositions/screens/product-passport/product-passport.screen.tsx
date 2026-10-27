import { Anchor, Button, Text } from "@mantine/core";
import { ArrowRight, Pencil, Plus } from "lucide-react";
import { Link } from "react-router-dom";
import { getRelatedDocuments, useProductDemo } from "domains/product-demo";
import { useProjectBasePath } from "domains/project";
import { ProductPage, useProductPath } from "compositions/widgets/product-page";
import { MarkdownView } from "ui/markdown-view";
import { StatePanel } from "ui/state-panel";
import styles from "./styles/product-passport.module.css";

/**
 * Объясняет назначение продукта и открывает его карту реализации.
 *
 * Используется для:
 *  - знакомства с продуктом и редактирования нового паспорта
 */
export const ProductPassportScreen = () => {
  const { snapshot } = useProductDemo();
  const base = useProductPath();
  const projectBase = useProjectBasePath();
  const passportData = snapshot.passport;
  const isEmpty = passportData.name === "";
  const featureCount = snapshot.features.length;
  const scenarioCount = snapshot.features.reduce(
    (count, feature) => count + feature.scenarios.length,
    0,
  );
  const applicationCount = snapshot.applications.length;
  const relatedDocuments = getRelatedDocuments(snapshot, [JSON.stringify({ kind: "product" })]);
  if (isEmpty)
    return (
      <ProductPage
        title="Паспорт продукта"
        description="Начните с общего понимания: что создаём, для кого и зачем."
      >
        <StatePanel
          title="У продукта пока нет паспорта"
          description="Опишите назначение, пользователей и границы. Затем добавьте фичи и приложения."
          action={
            <Button
              component={Link}
              to={`${base}/passport/edit`}
              leftSection={<Plus size={15} aria-hidden="true" />}
            >
              Заполнить паспорт
            </Button>
          }
        />
      </ProductPage>
    );
  return (
    <ProductPage
      title={passportData.name}
      description={passportData.summary}
      eyebrow="ПРОДУКТ / ПАСПОРТ"
      actions={
        <Button
          component={Link}
          to={`${base}/passport/edit`}
          variant="default"
          leftSection={<Pencil size={14} aria-hidden="true" />}
        >
          Редактировать
        </Button>
      }
    >
      <div className={styles.root}>
        <article className={styles.document} aria-label="Описание продукта">
          <MarkdownView text={passportData.description} />
        </article>
        <aside className={styles.aside} aria-label="Карта продукта">
          <section className={styles.panel}>
            <h2 className={styles.panelTitle}>Карта продукта</h2>
            <Text size="sm" c="dimmed" mb="lg">
              От замысла к работающему сценарию.
            </Text>
            <Link className={styles.stat} to={`${base}/features`}>
              <span className={styles.statLabel}>
                <span className={styles.dot} data-status="done" />
                Фичи
              </span>
              <strong>{featureCount}</strong>
            </Link>
            <Link className={styles.stat} to={`${base}/features`}>
              <span className={styles.statLabel}>
                <span className={styles.dot} data-status="partial" />
                Сценарии
              </span>
              <strong>{scenarioCount}</strong>
            </Link>
            <Link className={styles.stat} to={`${base}/applications`}>
              <span className={styles.statLabel}>
                <span className={styles.dot} data-status="none" />
                Приложения
              </span>
              <strong>{applicationCount}</strong>
            </Link>
            <Button
              component={Link}
              to={`${base}/features`}
              fullWidth
              variant="default"
              mt="lg"
              rightSection={<ArrowRight size={14} aria-hidden="true" />}
            >
              Все фичи · {snapshot.features.length}
            </Button>
            <Link to={`${base}/applications`} className={styles.appLink}>
              Приложения · {snapshot.applications.length}
              <ArrowRight size={14} aria-hidden="true" />
            </Link>
          </section>
          <section className={styles.panel} aria-label="Документы продукта">
            <h2 className={styles.panelTitle}>Документы продукта</h2>
            <ul>
              {relatedDocuments.map((document) => (
                <li key={document.id}>
                  <Anchor
                    component={Link}
                    c="var(--mantine-color-text)"
                    to={`${projectBase}/documents/${document.id}`}
                  >
                    {document.name}
                  </Anchor>
                </li>
              ))}
            </ul>
          </section>
          <Text size="xs" c="dimmed" lh={1.7}>
            Статус реализации задаётся явно в приложении. Готовность общих требований Core не
            предоставляет.
          </Text>
        </aside>
      </div>
    </ProductPage>
  );
};
