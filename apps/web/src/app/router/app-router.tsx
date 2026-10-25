import { createBrowserRouter } from "react-router-dom";
import { RelayScreen } from "compositions/screens/relay";
import { ProjectLayout } from "compositions/layouts/project";
import { OverviewScreen } from "compositions/screens/overview";
import { EntityRoute } from "compositions/route-boundaries/entity-route";
import { RouteError } from "compositions/route-boundaries/route-error";
import { KnowledgeScreen } from "compositions/screens/knowledge";
import { DocumentsScreen } from "compositions/screens/documents";
import { BoardScreen } from "compositions/screens/board";
import { TaskScreen } from "compositions/screens/task";
import {
  PlansScreen,
  PlanScreen,
  ReleasesScreen,
  ReleaseScreen,
} from "compositions/screens/planning";
import { HistoryScreen, SessionScreen } from "compositions/screens/history";

export const router = createBrowserRouter([
  { path: "/", element: <RelayScreen />, errorElement: <RouteError /> },
  {
    path: "/projects/:projectId",
    element: <RelayScreen />,
    errorElement: <RouteError />,
    children: [
      {
        element: <ProjectLayout />,
        children: [
          { index: true, element: <OverviewScreen /> },
          { path: "knowledge/:kind", element: <KnowledgeScreen /> },
          { path: "entities/:ref", element: <EntityRoute /> },
          { path: "documents", element: <DocumentsScreen /> },
          { path: "board", element: <BoardScreen /> },
          { path: "tasks/:ref", element: <TaskScreen /> },
          { path: "plans", element: <PlansScreen /> },
          { path: "plans/:ref", element: <PlanScreen /> },
          { path: "releases", element: <ReleasesScreen /> },
          { path: "releases/:ref", element: <ReleaseScreen /> },
          { path: "history", element: <HistoryScreen /> },
          { path: "history/sessions/:ref", element: <SessionScreen /> },
        ],
      },
    ],
  },
]);
