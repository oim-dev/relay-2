import { useState } from "react";
import { Anchor, Button, Collapse, Text } from "@mantine/core";
import { useMediaQuery } from "@mantine/hooks";
import { Link } from "react-router-dom";
import { Folder } from "lucide-react";
import { useProjectBasePath } from "domains/project";
import { DocumentRelations } from "compositions/widgets/document-relations";
import type { DocumentContextProps } from "./types/document-context-props.type";
import styles from "./styles/document-context.module.css";

/**
 * Даёт контекст документа рядом с текстом, не превращая чтение в форму.
 *
 * Используется для:
 *  - переходов к связанным сущностям и разделам содержания
 */
export const DocumentContext = ({
  document,
  sectionName,
  outline,
  onSave,
}: DocumentContextProps) => {
  const base = useProjectBasePath();
  const isWide = useMediaQuery("(min-width: 75em)");
  const [isExpanded, setExpanded] = useState(false);
  const isOpen = isWide || isExpanded;
  const toggleLabel = isExpanded
    ? "Свернуть прикрепления и содержание"
    : `Прикрепления (${document.relations.length}) и содержание`;
  const hasOutline = outline.length >= 3;
  const sectionHref = document.sectionId
    ? `${base}/documents?section=${encodeURIComponent(document.sectionId)}`
    : `${base}/documents?view=none`;
  return (
    <aside
      className={styles.root}
      id="context"
      tabIndex={-1}
      aria-label="Свойства и прикрепления документа"
    >
      <div className={styles.properties}>
        <Text size="xs" c="dimmed">
          В библиотеке
        </Text>
        <Anchor component={Link} to={sectionHref} className={styles.sectionLink} c="inherit">
          <Folder size={15} aria-hidden="true" />
          {sectionName}
        </Anchor>
      </div>
      {!isWide && (
        <Button
          variant="subtle"
          color="gray"
          size="xs"
          aria-expanded={isOpen}
          onClick={() => setExpanded(!isExpanded)}
        >
          {toggleLabel}
        </Button>
      )}
      <Collapse expanded={isOpen}>
        <DocumentRelations
          value={document.relations}
          references={document.references}
          documentId={document.id}
          onChange={(relations) => onSave({ relations })}
        />
        {hasOutline && (
          <nav className={styles.outline} aria-label="Содержание документа">
            <h2 className={styles.title}>Содержание</h2>
            {outline.map((entry) => (
              <Anchor
                key={entry.id}
                href={`#${entry.id}`}
                data-nested={entry.level > 2}
                className={styles.outlineLink}
                c="dimmed"
              >
                {entry.title}
              </Anchor>
            ))}
          </nav>
        )}
      </Collapse>
    </aside>
  );
};
