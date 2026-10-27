import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { Alert, Button } from "@mantine/core";
import { useProjectBasePath, useProjectId } from "domains/project";
import {
  createReleaseDraft,
  useRelease,
  saveRelease,
  useReleasesRefresh,
  ReleaseError,
} from "domains/releases";
import type { Release, ReleaseStatus } from "domains/releases";
import { isDefined } from "shared/value-predicates";
import { StatePanel } from "ui/state-panel";
import { ReleaseCatalog } from "../release-catalog";
import { ReleaseDetail } from "../release-detail";
import { ReleaseForm } from "../release-form";
import styles from "./styles/releases-view.module.css";

/**
 * Координирует каталог, просмотр и создание самостоятельных релизов.
 *
 * Используется для:
 *  - сохранения выбранных планов и собственного статуса выпуска
 */
export const ReleasesView = () => {
  const projectId = useProjectId();
  const basePath = useProjectBasePath();
  const navigate = useNavigate();
  const { releaseId } = useParams();
  const releaseQuery = useRelease(projectId, releaseId ?? null);
  const refresh = useReleasesRefresh(projectId);
  const [editor, setEditor] = useState<Release | null>(null);
  const releaseData = releaseQuery.data;
  const hasUnknownRelease =
    releaseQuery.error instanceof ReleaseError && releaseQuery.error.code === "ENTITY_NOT_FOUND";
  const isNew = editor?.revision === 0;

  /**
   * Открывает новую сущность с пустым составом и статусом «Запланирован».
   */
  const handleCreate = () => {
    setEditor(createReleaseDraft());
  };

  /**
   * Сохраняет релиз, затем открывает его постоянный адрес.
   */
  const handleSave = async (release: Release): Promise<string | null> => {
    try {
      const saved = await saveRelease(projectId, release);
      void refresh().catch(() => undefined);
      navigate(`${basePath}/releases/${saved.id}`);
      return null;
    } catch (error) {
      if (error instanceof ReleaseError) return error.message;
      throw error;
    }
  };

  /**
   * Открывает предметную форму, при необходимости предлагая новый статус.
   */
  const handleEdit = (status?: ReleaseStatus) => {
    if (isDefined(releaseData)) setEditor({ ...releaseData, status: status ?? releaseData.status });
  };

  if (isDefined(releaseId) && releaseQuery.isLoading)
    return (
      <StatePanel
        title="Загружаем релиз"
        titleAs="h1"
        description="Читаем постоянные данные проекта."
      />
    );
  if (isDefined(releaseQuery.error) && !isDefined(releaseData) && !hasUnknownRelease)
    return (
      <StatePanel
        title="Релизы недоступны"
        titleAs="h1"
        description={releaseQuery.error.message}
        action={<Button onClick={() => void releaseQuery.mutate()}>Повторить чтение</Button>}
      />
    );
  if (hasUnknownRelease && !isDefined(releaseData))
    return (
      <StatePanel
        title="Релиз не найден"
        titleAs="h1"
        description="В этом проекте нет релиза с таким адресом."
        action={
          <Button component={Link} to={`${basePath}/releases`}>
            Все релизы
          </Button>
        }
      />
    );

  return (
    <section className={styles.root}>
      {isDefined(releaseQuery.error) && (
        <Alert color="red" title="Не удалось обновить релиз">
          {releaseQuery.error.message}
          <Button size="xs" onClick={() => void releaseQuery.mutate()}>
            Повторить
          </Button>
        </Alert>
      )}
      {!isDefined(releaseId) && <ReleaseCatalog basePath={basePath} onCreate={handleCreate} />}
      {isDefined(releaseData) && (
        <ReleaseDetail
          key={`release-${releaseData.id}`}
          release={releaseData}
          basePath={basePath}
          onEdit={handleEdit}
        />
      )}
      {isDefined(editor) && (
        <ReleaseForm
          key={`editor-${editor.id}`}
          release={editor}
          projectId={projectId}
          isNew={isNew}
          onSave={handleSave}
          onClose={() => setEditor(null)}
        />
      )}
    </section>
  );
};
