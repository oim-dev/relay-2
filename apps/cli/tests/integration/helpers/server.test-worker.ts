import {
  acquireServerInstance,
  readServerLaunch,
  resolveServerScope,
} from "@relay/project-runtime";

const path = process.argv[2];
if (!path) {
  throw new Error("Тестовому серверу нужен launch path");
}
const launch = readServerLaunch(path);
const registration = acquireServerInstance(launch);
const app = Bun.serve({
  hostname: "127.0.0.1",
  port: launch.port,
  /**
   * Представляет минимальный HTTP listener; lifecycle проверяется реальными процессами и control.
   */
  fetch(): Response {
    return new Response("fixture");
  },
});
let closed = false;
/**
 * Закрывает HTTP и регистрационный lease fixture до завершения процесса.
 */
function stop(): void {
  if (closed) {
    return;
  }
  closed = true;
  app.stop(true);
  registration.close();
  process.exit(0);
}
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
process.stdin.on("end", stop);
process.stdin.resume();
registration.ready({
  url: `http://127.0.0.1:${app.port}/`,
  projects: resolveServerScope(launch.options).projects.map(
    ({ location: _location, identity: _identity, ...project }) => project,
  ),
  onStop: stop,
});
console.log(JSON.stringify({ instanceId: launch.instanceId, bootId: registration.bootId }));
