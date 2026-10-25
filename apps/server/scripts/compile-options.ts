/**
 * Неиспользуемые optional расширения Nest. Их lazy imports штатно обрабатывают отсутствие пакета.
 * Bun не должен разрешать их на build-time: Server использует только Fastify, собственные pipes,
 * byte-static handler и SSE; Express/microservices/WS/view/class-transformer не подключаются.
 * Это обычная external-настройка bundler без изменения node_modules и runtime заглушек.
 */
export const OPTIONAL_NEST_EXTENSIONS = [
  "@nestjs/platform-express",
  "@nestjs/microservices",
  "@nestjs/microservices/*",
  "@nestjs/websockets",
  "@nestjs/websockets/*",
  "@fastify/static",
  "@fastify/view",
  "class-transformer",
  "class-validator",
];
