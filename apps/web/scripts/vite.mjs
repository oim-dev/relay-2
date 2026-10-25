if ("bun" in process.versions) {
  throw new Error("В этом проекте Vite запускается под Node.js. Запустите скрипт через node.");
}

const manifest = import.meta.resolve("vite/package.json");
// Путь разрешается через workspace независимо от hoisted/isolated linker Bun.
// CLI остаётся в текущем Node-процессе и сам владеет argv, сигналами и завершением.
await import(new URL("./bin/vite.js", manifest).href);
