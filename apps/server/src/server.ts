import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import { RelayError } from "@relay/contracts";
import { ServerModule } from "./server.module";
import { RequestLifetime } from "./http/request-lifetime";
import { httpMessages } from "./http/http.messages";
import { EventsService } from "./modules/events/events.service";
import { ProjectsService } from "./modules/projects/projects.service";
import type {
  RelayServerApplication,
  RelayServerOptions,
  StartedRelayServer,
  StartRelayServerOptions,
} from "./server.types";

/**
 * Инициализирует Nest/Fastify без bind. Pipes получают исходный поток вместо Fastify JSON parser.
 * Владельцу передаётся обязанность close; constructor injection использует явные @Inject tokens.
 */
export async function createRelayServer(
  options: RelayServerOptions,
): Promise<RelayServerApplication> {
  const adapter = new FastifyAdapter({
    logger: false,
    forceCloseConnections: "idle",
    bodyLimit: Number.MAX_SAFE_INTEGER,
    requestTimeout: 0,
  });
  const fastify = adapter.getInstance();
  fastify.removeAllContentTypeParsers();
  fastify.addContentTypeParser("*", (_request, payload, done) => done(null, payload));
  const app = await NestFactory.create<NestFastifyApplication>(
    ServerModule.register(options),
    adapter,
    { logger: false, abortOnError: false, bodyParser: false },
  );
  const lifetime = app.get(RequestLifetime);
  // Hook предшествует Nest guard: ранний 403 также оставляет незавершённое входное тело.
  fastify.addHook("onRequest", (request, reply, done) => {
    lifetime.trackInput(request.raw, reply.raw);
    done();
  });
  try {
    await app.init();
    await fastify.ready();
  } catch (error) {
    await app.close();
    throw error;
  }
  let completion: Promise<void> | undefined;
  return {
    app,
    /**
     * Запрещает новые handlers, прекращает SSE, ожидает writers и закрывает listener последним.
     */
    close: (): Promise<void> => {
      if (completion === undefined) {
        lifetime.stop();
        completion = (async (): Promise<void> => {
          await app.get(EventsService).close();
          await lifetime.drain();
          await app.get(ProjectsService).close();
          await app.close();
        })();
      }
      return completion;
    },
  };
}

/**
 * Открывает loopback listener Nest/Fastify; port=0 возвращает фактический порт ОС.
 * Ошибка bind освобождает инициализированные ресурсы до отказа caller.
 */
export async function startRelayServer(
  options: StartRelayServerOptions,
): Promise<StartedRelayServer> {
  const hostname = options.hostname ?? "127.0.0.1";
  if (!["127.0.0.1", "localhost", "::1"].includes(hostname)) {
    throw new RelayError("INVALID_ARGUMENT", httpMessages.loopback, 2);
  }
  const hosts: string[] = [];
  const server = await createRelayServer({
    ...options,
    allowedHosts: options.allowedHosts ?? hosts,
  });
  try {
    await server.app.listen(options.port ?? 3210, hostname);
    const address = server.app.getHttpServer().address();
    if (address === null || typeof address === "string") {
      throw new RelayError("INTERNAL_ERROR", httpMessages.internal);
    }
    const port = address.port;
    hosts.push(`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`);
    const url = new URL(await server.app.getUrl());
    return { ...server, port, url: url.href };
  } catch (error) {
    await server.close();
    throw error;
  }
}
