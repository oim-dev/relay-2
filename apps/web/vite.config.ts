import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  resolve: {
    tsconfigPaths: true,
  },
  server: {
    port: Number(process.env.RELAY_WEB_PORT ?? 5174),
    strictPort: true,
    proxy: {
      "/api": { target: process.env.RELAY_API_URL ?? "http://127.0.0.1:3210", changeOrigin: true },
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    target: "es2022",
    // Цветовая схема Mantine определяется во время выполнения; light-dark должен остаться нативным.
    cssTarget: ["chrome123", "firefox120", "safari17.5"],
  },
});
