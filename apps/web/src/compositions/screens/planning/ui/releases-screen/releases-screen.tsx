import { useState, type ReactElement } from "react";
import { Link, useSearchParams } from "react-router-dom";
import {
  Alert,
  Badge,
  Button,
  Card,
  Group,
  Select,
  SimpleGrid,
  Stack,
  Text,
  TextInput,
  Title,
} from "@mantine/core";
import { RELEASE_STATUSES } from "@relay/contracts";
import { errorMessage, useEntityPages, useProject } from "domains/project";
import { ReleaseForm } from "../release-form/release-form";
import { planningMessages as m } from "../../planning.messages";

/**
 * Показывает каталог выпусков с серверным поиском и созданием релиза.
 *
 * Используется для:
 *  - просмотра запланированных, опубликованных и отменённых выпусков
 *  - открытия состава выбранного релиза
 */
export function ReleasesScreen(): ReactElement {
  const { projectId } = useProject();
  const [params, setParams] = useSearchParams();
  const [creating, setCreating] = useState(false);
  const query = params.get("q") ?? "";
  const status = params.get("status") ?? "";
  const page = useEntityPages("release", {
    ...(query.trim() === "" ? {} : { q: query }),
    ...(status === "" ? {} : { status }),
  });
  const releases = page.items.filter((entry) => entry.kind === "release");
  const isEmpty = !page.loading && page.error === undefined && !releases.some(Boolean);
  /**
   * Обновляет адресный фильтр, сбрасывая страницу у владельца запроса.
   */
  function filter(name: string, value: string): void {
    const next = new URLSearchParams(params);
    if (value === "") {
      next.delete(name);
    } else {
      next.set(name, value);
    }
    setParams(next, { replace: true });
  }
  return (
    <Stack>
      <Group justify="space-between">
        <Title order={1}>{m.releases}</Title>
        <Button onClick={() => setCreating(true)}>{m.newRelease}</Button>
      </Group>
      <Group grow>
        <TextInput
          label={m.search}
          value={query}
          onChange={(event) => filter("q", event.currentTarget.value)}
        />
        <Select
          label={m.status}
          placeholder={m.all}
          clearable
          value={status || null}
          data={RELEASE_STATUSES.map((value) => ({ value, label: m.releaseStatus[value] }))}
          onChange={(value) => filter("status", value ?? "")}
        />
      </Group>
      {page.error !== undefined && (
        <Alert color="red" title={m.readFailure}>
          {errorMessage(page.error)}
          <Button variant="subtle" onClick={page.reload}>
            {m.refresh}
          </Button>
        </Alert>
      )}
      {page.loading && <Text role="status">{m.loading}</Text>}
      {isEmpty && <Text c="dimmed">{m.empty}</Text>}
      <SimpleGrid cols={{ base: 1, md: 2 }}>
        {releases.map((release) => (
          <Card key={release.id} withBorder>
            <Stack gap="xs">
              <Group justify="space-between">
                <Text size="sm" c="dimmed">
                  {release.data.version}
                </Text>
                <Badge variant="light">{m.releaseStatus[release.data.status]}</Badge>
              </Group>
              <Title order={2} size="h3">
                <Link to={`/projects/${projectId}/releases/${release.id}`}>
                  {release.data.title}
                </Link>
              </Title>
              <Text size="sm" lineClamp={3}>
                {release.data.summary}
              </Text>
              <Text size="sm" c="dimmed">
                {release.data.plannedFor}
              </Text>
            </Stack>
          </Card>
        ))}
      </SimpleGrid>
      {page.hasMore && (
        <Button variant="default" loading={page.loading} onClick={page.loadMore}>
          {m.more}
        </Button>
      )}
      {creating && <ReleaseForm onClose={() => setCreating(false)} />}
    </Stack>
  );
}
