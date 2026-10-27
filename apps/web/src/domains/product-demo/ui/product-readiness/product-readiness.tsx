import clsx from "clsx";
import { Check } from "lucide-react";
import { PRODUCT_STATUS_OPTIONS } from "../../config/product-demo.config";
import type { ProductReadinessProps } from "./types/product-readiness-props.type";
import styles from "./styles/product-readiness.module.css";

/**
 * Показывает готовность круглым индикатором и доступной подписью без действия переключения.
 *
 * Используется для:
 *  - чтения статусов в дереве, легенде и подразделах фичи
 */
export const ProductReadiness = (props: ProductReadinessProps) => {
  const { status, isCompact = false, label, className, ...rootAttrs } = props;
  const statusLabel =
    label ??
    PRODUCT_STATUS_OPTIONS.find((option) => option.value === status)?.label ??
    "Готовность не предоставляется";
  const isDone = status === "done";
  const isPartial = status === "partial";
  const hasCheck = isDone || isPartial;
  return (
    <span {...rootAttrs} title={statusLabel} className={clsx(styles.root, className)}>
      <span
        aria-hidden="true"
        className={clsx(styles.icon, isDone && styles._done, isPartial && styles._partial)}
      >
        {hasCheck && <Check size={13} strokeWidth={3} />}
      </span>
      <span className={clsx(styles.label, isCompact && styles._compact)}>{statusLabel}</span>
    </span>
  );
};
