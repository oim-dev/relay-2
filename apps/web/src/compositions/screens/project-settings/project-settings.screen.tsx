import { Anchor, Button, Text, Title } from "@mantine/core";
import { Link } from "react-router-dom";
import { ArrowLeft, SlidersHorizontal } from "lucide-react";
import { useProjectBasePath, useProjectSettings } from "domains/project";
import { isDefined } from "shared/value-predicates";
import { StatePanel } from "ui/state-panel";
import { GeneralSettings } from "./ui/general-settings";
import styles from "./styles/project-settings.module.css";

/**
 * Представляет настройки текущего проекта как отдельный расширяемый раздел.
 *
 * Используется для:
 *  - чтения и изменения имени и адреса проекта
 *  - отображения загрузки и восстановления после ошибки чтения
 */
export const ProjectSettingsScreen = () => {
  const basePath = useProjectBasePath();
  const query = useProjectSettings();
  const settingsData = query.data;
  const hasSettings = isDefined(settingsData);
  const hasLoadError = isDefined(query.error);
  return (
    <section className={styles.root} aria-labelledby="project-settings-title">
      <header className={styles.heading}>
        <Anchor component={Link} to={`${basePath}/`} className={styles.back} size="sm" c="dimmed">
          <ArrowLeft size={14} aria-hidden="true" /> К проекту
        </Anchor>
        <Title id="project-settings-title" order={1} className={styles.title}>
          Настройки проекта
        </Title>
        <Text c="dimmed" size="sm">
          Всё, что определяет ваш проект в Relay.
        </Text>
      </header>
      <div className={styles.layout}>
        <nav className={styles.navigation} aria-label="Разделы настроек">
          <div className={styles.caption}>НАСТРОЙКИ</div>
          <a href="#general" className={styles.sectionLink} aria-current="location">
            <SlidersHorizontal size={17} aria-hidden="true" />
            <span>
              Основное<span className={styles.sectionDescription}>Имя и адрес проекта</span>
            </span>
          </a>
        </nav>
        <div className={styles.content}>
          {hasSettings && <GeneralSettings settings={settingsData} />}
          {!hasSettings && (
            <StatePanel
              isLoading={query.isLoading}
              title="Настройки проекта"
              description="Загружаем имя и адрес проекта."
              action={
                <Button variant="default" onClick={() => void query.mutate()}>
                  Повторить загрузку
                </Button>
              }
            />
          )}
          {hasLoadError && (
            <Text role="status" c="red" size="sm" mt="md">
              Не удалось обновить настройки. Проверьте подключение и повторите загрузку.
            </Text>
          )}
        </div>
      </div>
    </section>
  );
};
