import type { ReactElement } from "react";
import { isRouteErrorResponse, Link, useRouteError } from "react-router-dom";
import { Button, Group } from "@mantine/core";
import { StatePanel } from "ui/state-panel";
import { routeErrorMessages as m } from "./route-error.messages";

/**
 * Сохраняет видимую диагностику неожиданного сбоя маршрута и путь возвращения.
 */
export function RouteError(): ReactElement {
  const error = useRouteError();
  let message: string = m.unknown;
  if (isRouteErrorResponse(error)) {
    message = `${error.status}: ${error.statusText}`;
  } else if (error instanceof Error) {
    message = error.message;
  }
  return (
    <StatePanel
      title={m.title}
      description={message}
      action={
        <Group>
          <Button component={Link} to="/">
            {m.projects}
          </Button>
          <Button variant="default" onClick={() => window.location.reload()}>
            {m.reload}
          </Button>
        </Group>
      }
    />
  );
}
