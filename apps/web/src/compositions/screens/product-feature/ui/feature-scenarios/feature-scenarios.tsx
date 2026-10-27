import clsx from "clsx";
import { useState } from "react";
import { Button, Text } from "@mantine/core";
import { Plus } from "lucide-react";
import { Link, useLocation } from "react-router-dom";
import { useProductPath } from "compositions/widgets/product-page";
import { isEmptyArray } from "shared/value-predicates";
import { ScenarioSection } from "./ui/scenario-section/scenario-section";
import type { FeatureScenariosProps } from "./types/feature-scenarios-props.type";
import styles from "./styles/feature-scenarios.module.css";

/**
 * Представляет постоянные подразделы фичи и точку добавления нового сценария.
 *
 * Используется для:
 *  - чтения ожидаемого поведения и перехода к редактору сценария
 */
export const FeatureScenarios = (props: FeatureScenariosProps) => {
  const { feature, className, ...rootAttrs } = props;
  const base = useProductPath();
  const location = useLocation();
  const [count, setCount] = useState(10);
  const orderedScenarios = [...feature.scenarios].sort((left, right) =>
    (left.key ?? left.name).localeCompare(right.key ?? right.name, "ru", { numeric: true }),
  );
  const anchorIndex = orderedScenarios.findIndex(
    (entry) => location.hash === `#scenario-${entry.id}`,
  );
  const visibleCount = Math.max(count, anchorIndex + 1);
  const scenarioItems = orderedScenarios.slice(0, visibleCount);
  const hasMore = visibleCount < feature.scenarios.length;
  const featurePath = `${base}/features/${feature.key ?? feature.id}`;
  const hasNoScenarios = isEmptyArray(feature.scenarios);
  return (
    <section {...rootAttrs} id="scenarios" tabIndex={-1} className={clsx(styles.root, className)}>
      <header className={styles.header}>
        <div>
          <h2 className={styles.title}>Сценарии фичи</h2>
          <Text size="sm" c="dimmed">
            Сценариев: {feature.scenarios.length} · статус задаётся отдельно у реализаций приложений
          </Text>
        </div>
        <Button
          component={Link}
          to={`${featurePath}/scenarios/new${location.search}`}
          variant="default"
          size="sm"
          leftSection={<Plus size={14} aria-hidden="true" />}
        >
          Добавить сценарий
        </Button>
      </header>
      {hasNoScenarios && (
        <div className={styles.empty}>
          <Text fw={600}>Сценарии не описаны</Text>
          <Text size="sm" c="dimmed" mt="xs">
            Опишите первое конкретное поведение. У сценария будет собственная страница и список
            задач.
          </Text>
        </div>
      )}
      <div className={styles.sections}>
        {scenarioItems.map((scenario) => (
          <ScenarioSection
            key={scenario.id}
            scenario={scenario}
            featurePath={featurePath}
            search={location.search}
          />
        ))}
      </div>
      {hasMore && (
        <Button variant="subtle" mt="md" onClick={() => setCount(visibleCount + 10)}>
          Ещё сценарии · показано {scenarioItems.length} из {feature.scenarios.length}
        </Button>
      )}
    </section>
  );
};
