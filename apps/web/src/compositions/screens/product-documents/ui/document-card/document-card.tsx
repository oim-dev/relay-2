import { Badge, Anchor } from "@mantine/core";
import { FileText, PencilLine, Link2, Pin, ArrowUpRight } from "lucide-react";
import { Link } from "react-router-dom";
import { DOCUMENT_KINDS } from "domains/documents";
import type { DocumentCardProps } from "./types/document-card-props.type";
import styles from "./styles/document-card.module.css";

/**
 * Показывает назначение и состояние документа без открытия полного текста.
 *
 * Используется для:
 *  - просмотра библиотеки и результатов поиска
 */
export const DocumentCard = ({ document, sectionName, href, returnTo }: DocumentCardProps) => {
  const data = document.document;
  if (!data) return null;
  const isDraft = data.status === "draft";
  const isArchived = data.status === "archived";
  const hasSummary = document.summary !== "" || data.excerpt !== undefined;
  const Icon = isDraft ? PencilLine : FileText;
  const dateLabel = new Date(data.updatedAt).toLocaleDateString("ru-RU", {
    day: "numeric",
    month: "short",
  });
  const summary = data.excerpt ?? document.summary;
  const linkWord = new Intl.PluralRules("ru").select(data.linkCount);
  const linkLabel =
    data.linkCount === 0
      ? "Без прикреплений"
      : `${data.linkCount} ${linkWord === "one" ? "прикрепление" : linkWord === "few" ? "прикрепления" : "прикреплений"}`;
  return (
    <article className={styles.root}>
      <div className={styles.icon} data-draft={isDraft}>
        <Icon size={20} strokeWidth={1.5} aria-hidden="true" />
      </div>
      <div className={styles.content}>
        <div className={styles.heading}>
          <Anchor
            component={Link}
            to={href}
            state={{ returnTo }}
            className={styles.title}
            c="inherit"
          >
            {document.title}
          </Anchor>
          {data.pinned && <Pin size={13} className={styles.pin} aria-label="Закреплён" />}
          {isDraft && (
            <Badge variant="light" color="yellow" c="var(--tasks-warning-ink)" size="xs" tt="none">
              Черновик
            </Badge>
          )}
          {isArchived && (
            <Badge variant="light" color="gray" size="xs" tt="none">
              Архив
            </Badge>
          )}
        </div>
        {hasSummary && <p className={styles.summary}>{summary}</p>}
        <div className={styles.meta}>
          <span>{DOCUMENT_KINDS[data.kind]}</span>
          <span className={styles.dot} aria-hidden="true">
            ·
          </span>
          <span>{sectionName}</span>
          <Anchor
            component={Link}
            to={`${href}#context`}
            state={{ returnTo }}
            className={styles.relations}
            c="dimmed"
          >
            <Link2 size={12} aria-hidden="true" />
            {linkLabel}
          </Anchor>
        </div>
      </div>
      <div className={styles.trailing}>
        <time dateTime={data.updatedAt}>{dateLabel}</time>
        <ArrowUpRight size={15} aria-hidden="true" />
      </div>
    </article>
  );
};
