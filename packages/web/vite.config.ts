import { resolve } from "node:path";
import { defineConfig, loadEnv } from "vite";

export default defineConfig(({ mode }) => {
  const envDir = resolve(import.meta.dirname, "../..");
  const env = loadEnv(mode, envDir, "");
  const backendPort = process.env.PORT || env.PORT || "4173";

  return {
    envDir,
    server: {
      port: 5173,
      proxy: {
        "/api": {
          target: `http://127.0.0.1:${backendPort}`,
          changeOrigin: true,
        },
      },
    },
    build: {
      target: "esnext",
    },
  };
});
