import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

if ("bun" in process.versions) {
  throw new Error("Vite запускается под Node.js. Используйте bun run dev или bun run build.");
}

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: Object.fromEntries(
      ["app", "compositions", "domains", "infra", "ui", "shared"].map((layer) => [
        layer,
        fileURLToPath(new URL(`./src/${layer}`, import.meta.url)),
      ]),
    ),
  },
  server: {
    host: "127.0.0.1",
    port: Number(process.env.RELAY_WEB_PORT ?? "5173"),
    strictPort: true,
    proxy: {
      "/api": {
        target: process.env.RELAY_API_URL ?? "http://127.0.0.1:3210",
        changeOrigin: true,
      },
    },
  },
  build: {
    target: "es2023",
    // Mantine переключает color-scheme в runtime; light-dark должен остаться нативным.
    cssTarget: ["chrome123", "firefox120", "safari17.5"],
    outDir: "dist",
    emptyOutDir: true,
  },
});
