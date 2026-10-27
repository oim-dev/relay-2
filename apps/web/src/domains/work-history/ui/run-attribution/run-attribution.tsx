import clsx from "clsx";
import type { RunAttributionProps } from "./types/run-attribution-props.type";
import styles from "./styles/run-attribution.module.css";

/**
 * Разделяет агента, человека и внешний клиент сохранённого подключения.
 *
 * Используется для:
 *  - атрибуции участия без предположений об авторизации и присутствии в сети
 */
export const RunAttribution = (props: RunAttributionProps) => {
  const { run, compact = false, className, ...rootAttrs } = props;
  const operatorName = run?.operator?.name ?? "не указан";
  const operatorEmail = run?.operator?.email ?? "не указан";
  const sourceLabels = {
    explicit: "передано явно",
    environment: "окружение клиента",
    git: "конфигурация Git",
    inherited: "унаследовано",
  };
  const sourceLabel =
    run?.operator === undefined || run.operator === null
      ? "не указан"
      : sourceLabels[run.operator.source];
  const hasDetails = !compact;
  return (
    <dl {...rootAttrs} className={clsx(styles.root, className)}>
      <div>
        <dt>Агент</dt>
        <dd>{run?.actor ?? "не указан"}</dd>
      </div>
      <div>
        <dt>Пользователь</dt>
        <dd>{operatorName}</dd>
      </div>
      <div>
        <dt>Email</dt>
        <dd>{operatorEmail}</dd>
      </div>
      {hasDetails && (
        <>
          <div>
            <dt>Источник атрибуции</dt>
            <dd>{sourceLabel}</dd>
          </div>
          <div>
            <dt>Клиент</dt>
            <dd>{run?.client ?? "не указан"}</dd>
          </div>
          <div>
            <dt>Внешняя сессия</dt>
            <dd>
              <code>{run?.sourceSessionId ?? "не указана"}</code>
            </dd>
          </div>
        </>
      )}
    </dl>
  );
};
