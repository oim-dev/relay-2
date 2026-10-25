import clsx from "clsx";
import type { {{name.pascalCase}}Props } from "./types/{{name.kebabCase}}-props.type";
import styles from "./styles/{{name.kebabCase}}.module.css";

/**
 * Визуальная область {{name.pascalCase}}.
 *
 * Используется для:
 *  - отображения содержимого владельца
 */
export const {{name.pascalCase}} = (props: {{name.pascalCase}}Props) => {
  const { children, className, ...rootAttrs } = props;
  return <div {...rootAttrs} className={clsx(styles.root, className)}>{children}</div>;
};
