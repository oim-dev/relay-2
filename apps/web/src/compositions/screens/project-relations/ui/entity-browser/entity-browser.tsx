import { useState } from "react";
import {
  Alert,
  Button,
  Group,
  Pagination,
  Select,
  Skeleton,
  Stack,
  Text,
  TextInput,
  ThemeIcon,
  UnstyledButton,
} from "@mantine/core";
import { useDebouncedValue } from "@mantine/hooks";
import { ChevronRight, Search } from "lucide-react";
import { useEntities } from "domains/entities";
import type { EntityKind } from "domains/entities";
import { relationAddress } from "domains/relations";
import { isEmptyArray } from "shared/value-predicates";
import {
  ENTITY_PRESENTATION,
  PAGE_CONTROL_LABELS,
  getEntityPresentation,
} from "../../config/relation-presentation";
import type { EntityBrowserProps } from "./types/entity-browser-props.type";
import styles from "./styles/entity-browser.module.css";

/**
 * Помогает найти отправную точку исследования связей.
 *
 * Используется для:
 *  - серверного поиска и постраничного выбора сущностей проекта
 */
export const EntityBrowser = ({ projectId, selected, onSelect }: EntityBrowserProps) => {
  const [search, setSearch] = useState("");
  const [kind, setKind] = useState<EntityKind | undefined>();
  const [page, setPage] = useState({ offset: 0, version: undefined as string | undefined });
  const [debouncedSearch] = useDebouncedValue(search, 200);
  const query = useEntities(projectId, { q: debouncedSearch, kind, limit: 40, ...page });
  const entityItems = (query.data?.items ?? []).map((entity) => ({
    ...entity,
    address: relationAddress(entity.ref),
    presentation: getEntityPresentation(entity.ref.kind),
    isSelected: relationAddress(entity.ref) === selected,
  }));
  const kindItems = Object.entries(ENTITY_PRESENTATION).map(([value, entry]) => ({
    value,
    label: entry.label,
  }));
  const hasError = query.error !== undefined;
  const isEmpty = !query.isLoading && !hasError && isEmptyArray(entityItems);
  const total = query.data?.total ?? 0;
  const pageCount = Math.ceil(total / 40);
  const hasPages = pageCount > 1;
  const hasResults = !query.isLoading && !hasError;
  /**
   * Меняет вид только на одно из известных значений каталога.
   */
  const handleKind = (value: string | null): void => {
    const nextKind = (Object.keys(ENTITY_PRESENTATION) as EntityKind[]).find(
      (entry) => entry === value,
    );
    setKind(nextKind);
    setPage({ offset: 0, version: undefined });
  };
  /**
   * Обновляет изменившийся снимок, сохраняя условия поиска.
   */
  const handleRefresh = (): void => {
    setPage({ offset: 0, version: undefined });
    void query.mutate().catch(() => undefined);
  };
  return (
    <section className={styles.root} aria-label="Каталог сущностей">
      <Stack gap="sm" p="md">
        <Group justify="space-between">
          <Text fw={600} size="sm">
            Сущности проекта
          </Text>
          {hasResults && (
            <Text size="xs" c="dimmed">
              {total}
            </Text>
          )}
        </Group>
        <TextInput
          aria-label="Найти сущность"
          placeholder="Название или ключ…"
          leftSection={<Search size={15} aria-hidden="true" />}
          value={search}
          onChange={(event) => {
            setSearch(event.currentTarget.value);
            setPage({ offset: 0, version: undefined });
          }}
        />
        <Select
          aria-label="Вид сущности"
          placeholder="Все виды сущностей"
          clearable
          data={kindItems}
          value={kind ?? null}
          onChange={handleKind}
        />
      </Stack>
      {query.isLoading && (
        <Stack p="md" aria-label="Загрузка каталога">
          <Skeleton h={48} />
          <Skeleton h={48} />
          <Skeleton h={48} />
        </Stack>
      )}
      {hasError && (
        <Alert color="red" m="sm" title="Каталог не загрузился">
          {query.error?.message}
          <Button variant="subtle" onClick={handleRefresh}>
            Повторить
          </Button>
        </Alert>
      )}
      {isEmpty && (
        <Text p="lg" size="sm" c="dimmed">
          Ничего не найдено. Попробуйте другой ключ или вид сущности.
        </Text>
      )}
      <div className={styles.list}>
        {entityItems.map(({ address, key, title, presentation, isSelected }) => (
          <UnstyledButton
            key={address}
            className={styles.entity}
            data-selected={isSelected}
            aria-current={isSelected}
            onClick={() => onSelect(address)}
          >
            <ThemeIcon color={presentation.color} variant="light" size={30} radius="md">
              <presentation.icon size={16} aria-hidden="true" />
            </ThemeIcon>
            <span className={styles.label}>
              <Text component="span" size="xs" c="dimmed">
                {key} · {presentation.label}
              </Text>
              <Text component="span" size="sm" className={styles.title}>
                {title}
              </Text>
            </span>
            <ChevronRight size={14} aria-hidden="true" className={styles.chevron} />
          </UnstyledButton>
        ))}
      </div>
      {hasPages && (
        <Stack p="sm" gap={6} align="center">
          <Text size="xs" c="dimmed">
            {page.offset + 1}–{Math.min(page.offset + 40, total)} из {total}
          </Text>
          <Pagination
            autoContrast
            classNames={{ control: styles.pageControl }}
            size="xs"
            total={pageCount}
            value={page.offset / 40 + 1}
            siblings={0}
            boundaries={1}
            getItemProps={(number) => ({ "aria-label": `Страница каталога ${number}` })}
            getControlProps={(control) => ({
              "aria-label": `${PAGE_CONTROL_LABELS[control]} каталога`,
            })}
            onChange={(number) =>
              setPage({ offset: (number - 1) * 40, version: query.data?.version })
            }
          />
        </Stack>
      )}
    </section>
  );
};
