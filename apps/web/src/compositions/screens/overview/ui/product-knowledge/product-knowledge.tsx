import clsx from "clsx";
import type { ProductKnowledgeProps } from "./types/product-knowledge-props.type";
import styles from "./styles/product-knowledge.module.css";

/**
 * Представляет текущие количества знаний Core в исходных строках карточки легаси.
 * Готовность требований не выводится из количества задач или явного статуса реализации.
 */
export const ProductKnowledge = (props: ProductKnowledgeProps) => {
  const { knowledge, className, ...rootAttrs } = props;
  const { byType } = knowledge.applications;
  return (
    <dl {...rootAttrs} className={clsx(styles.root, className)}>
      <div className={styles.row}>
        <dt>Фичи</dt>
        <dd className={styles.value}>{knowledge.features.total}</dd>
        <dd className={styles.detail}>Требования и возможности продукта</dd>
      </div>
      <div className={styles.row}>
        <dt>Сценарии</dt>
        <dd className={styles.value}>{knowledge.scenarios.total}</dd>
        <dd className={styles.detail}>Сценарии использования фич</dd>
      </div>
      <div className={styles.row}>
        <dt>Приложения</dt>
        <dd className={styles.value}>{knowledge.applications.total}</dd>
        <dd className={styles.detail}>
          клиентских {byType.frontend}, серверных {byType.backend}, внутренних {byType.internal}
        </dd>
      </div>
      <div className={styles.row}>
        <dt>Реализации</dt>
        <dd className={styles.value}>{knowledge.implementationsTotal}</dd>
        <dd className={styles.detail}>
          Фичи и сценарии в приложениях; статус и участие задаются отдельно
        </dd>
      </div>
    </dl>
  );
};
