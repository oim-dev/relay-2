import clsx from "clsx";
import { useEffect, useRef } from "react";
import { useLocation } from "react-router-dom";
import type { ProductPageProps } from "./types/product-page-props.type";
import styles from "./styles/product-page.module.css";

/**
 * Задаёт ритм чтения и возврат между страницами продукта.
 *
 * Используется для:
 *  - размещения восстановленных экранов внутри общего каркаса Relay
 */
export const ProductPage = (props: ProductPageProps) => {
  const { children, className, title, description, actions, meta, ...rootAttrs } = props;
  // Совместимые прежние параметры не являются атрибутами DOM.
  delete rootAttrs.eyebrow;
  delete rootAttrs.backTo;
  delete rootAttrs.backState;
  delete rootAttrs.backLabel;
  const headingRef = useRef<HTMLHeadingElement>(null);
  const location = useLocation();
  useEffect(() => {
    document.title = `${title} · Relay`;
    const target = document.getElementById(location.hash.slice(1));
    if (target !== null) {
      target.focus({ preventScroll: true });
      target.scrollIntoView({ block: "start" });
      return;
    }
    headingRef.current?.focus({ preventScroll: true });
  }, [location.pathname, location.hash, title]);
  return (
    <section {...rootAttrs} className={clsx(styles.root, className)}>
      <header className={styles.heading}>
        <div className={styles.titleBlock}>
          <h1 tabIndex={-1} ref={headingRef} className={styles.title}>
            {title}
          </h1>
          <p className={styles.description}>{description}</p>
          {meta}
        </div>
        <div className={styles.actions}>{actions}</div>
      </header>
      {children}
    </section>
  );
};
