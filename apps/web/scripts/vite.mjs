if ("bun" in process.versions) {
  throw new Error("Vite запускается под Node.js. Используйте package scripts приложения.");
}
const manifest = import.meta.resolve("vite/package.json");
await import(new URL("./bin/vite.js", manifest).href);
