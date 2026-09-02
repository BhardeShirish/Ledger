/// <reference types="vitest/config" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const backendPort = process.env.LEDGER_BACKEND_PORT || "8000";

export default defineConfig({
  plugins: [react()],
  server: {
    port: Number(process.env.LEDGER_FRONTEND_PORT) || 5173,
    proxy: {
      "/api": { target: `http://localhost:${backendPort}`, changeOrigin: true },
    },
  },
  build: { outDir: "dist", sourcemap: false },
  test: {
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
  },
});
