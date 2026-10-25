import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { RuntimeFixture } from "./runtime-fixture";

/**
 * Владеет независимым HTTP-broker и его настоящим detached-worker.
 * Каталог удаляется только после закрытия сервера, обработчиков и handle ребёнка.
 */
export class ProcessGuardianBrokerFixture extends RuntimeFixture {
  /* Тела принятых launch-запросов в порядке получения. */
  readonly requests: string[] = [];
  /* Сервер отсутствует до явного start; ошибка запуска также допускает dispose. */
  private server: Bun.Server<undefined> | undefined;
  /* Конкретный дочерний процесс broker, независимый от guardian короткого запроса. */
  private worker: ChildProcess | undefined;
  /* Барьер close включает exit и закрытие stdio; error сам по себе его не завершает. */
  private workerClosed: Promise<void> | undefined;
  /* Наблюдённое событие close; запрещает повторную остановку завершённого ребёнка. */
  private closed = false;
  /* Запрет нового spawn устанавливается синхронно до остановки HTTP-соединений. */
  private stopping = false;
  /* Резерв единственного worker, включая время чтения тела первого запроса. */
  private launching = false;
  /* Promise всех обработчиков: stop(true) ожидает соединения, а не произвольный JS. */
  private readonly handlers: Promise<Response>[] = [];
  /* Ошибки startup/обработчиков/cleanup сохраняются до завершения всех барьеров. */
  private readonly failures: unknown[] = [];

  /**
   * Запускает broker вне ancestry короткого запроса и возвращает его launch-endpoint.
   * Actor запускается только после получения POST; повторный start запрещён.
   */
  start(actor: string): string {
    if (this.server || this.stopping) {
      throw new Error("Broker fixture уже запущен или остановлен");
    }
    this.server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      /**
       * Учитывает обработчик до передачи Promise серверу, включая startup-ошибку.
       */
      fetch: (request): Promise<Response> => {
        const handler = this.launchWorker(request, actor);
        this.handlers.push(handler);
        return handler;
      },
    });
    return `http://127.0.0.1:${this.server.port}/launch`;
  }

  /**
   * Возвращает PID именно созданного broker ребёнка; отсутствие не означает успешный startup.
   */
  get workerPid(): number | undefined {
    return this.worker?.pid;
  }

  /**
   * Создаёт единственного worker и подтверждает готовность его собственным PID-барьером.
   * Ошибка сохраняется для dispose и возвращает отказ клиенту, а не started: true.
   */
  private async launchWorker(request: Request, actor: string): Promise<Response> {
    if (
      this.stopping ||
      this.launching ||
      request.method !== "POST" ||
      new URL(request.url).pathname !== "/launch"
    ) {
      return new Response(null, { status: 409 });
    }
    this.launching = true;
    try {
      const body = await request.text();
      if (this.stopping) {
        return new Response(null, { status: 503 });
      }
      this.requests.push(body);
      const worker = spawn(process.execPath, [actor, "persistent", this.root], {
        cwd: this.cwd,
        env: { PATH: process.env.PATH ?? "", HOME: this.root, USERPROFILE: this.root },
        detached: true,
        stdio: "ignore",
      });
      this.worker = worker;
      this.workerClosed = new Promise((resolve) => {
        worker.once("close", () => {
          this.closed = true;
          resolve();
        });
      });
      worker.on("error", (error) => this.failures.push(error));

      const ready = join(this.root, "leaf.pid");
      const deadline = performance.now() + 5000;
      while (!this.stopping) {
        if (this.closed || this.failures.length > 0) {
          throw new Error("Worker broker завершился до готовности");
        }
        if (existsSync(ready)) {
          const pid: unknown = JSON.parse(readFileSync(ready, "utf8"));
          if (pid !== worker.pid) {
            throw new Error("Барьер готовности не принадлежит worker broker");
          }
          return Response.json({ started: true });
        }
        if (performance.now() >= deadline) {
          throw new Error("Worker broker не опубликовал готовность");
        }
        await Bun.sleep(10);
      }
      return new Response(null, { status: 503 });
    } catch (error) {
      this.failures.push(error);
      return new Response(null, { status: 500 });
    }
  }

  /**
   * После assertions запрещает spawn, останавливает свой worker по handle и ждёт close.
   * Все начатые обработчики и server.stop входят в тот же барьер; отказ барьера сохраняет
   * каталог. Ошибки startup и cleanup возвращаются вместе после попытки полной остановки.
   */
  override async dispose(): Promise<void> {
    this.stopping = true;
    const barriers: Promise<unknown>[] = [...this.handlers];
    let drained = true;
    try {
      if (this.server) {
        barriers.push(this.server.stop(true));
      }
    } catch (error) {
      this.failures.push(error);
      drained = false;
    }
    if (this.workerClosed) {
      barriers.push(this.workerClosed);
    }
    try {
      if (this.worker && !this.closed) {
        this.worker.kill("SIGKILL");
      }
    } catch (error) {
      this.failures.push(error);
    }

    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const outcomes = await Promise.race([
        Promise.allSettled(barriers),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error("Broker fixture не завершил cleanup")), 5000);
        }),
      ]);
      for (const outcome of outcomes) {
        if (outcome.status === "rejected") {
          this.failures.push(outcome.reason);
          drained = false;
        }
      }
    } catch (error) {
      this.failures.push(error);
      drained = false;
    } finally {
      clearTimeout(timer);
    }
    if (drained) {
      try {
        await super.dispose();
      } catch (error) {
        this.failures.push(error);
      }
    }
    if (this.failures.length > 0) {
      throw new AggregateError(this.failures, "Ошибки независимого broker fixture");
    }
  }
}
