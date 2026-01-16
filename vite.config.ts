import path from "path";
import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");

  const API_BASE =
    env.VITE_API_BASE_URL || "http://3.17.64.165:8787";

  return {
    base: "/",

    plugins: [react()],

    server: {
      port: 3000,
      host: "0.0.0.0",

      // 🔐 REQUIRED when using domain + nginx proxy
      allowedHosts: [
        "ultibots.xyz",
        "www.ultibots.xyz"
      ],

      proxy: {
        "/api": {
          target: API_BASE,
          changeOrigin: true,
        },

        "/socket.io": {
          target: API_BASE,
          ws: true,
          changeOrigin: true,
        },
      },
    },

    /**
     * Browser-safe globals
     */
    define: {
      global: "globalThis",
      process: {
        env: {
          VITE_API_BASE_URL: JSON.stringify(API_BASE),
          VITE_SOCKET_BASE_URL: JSON.stringify(API_BASE),
          GEMINI_API_KEY: JSON.stringify(env.GEMINI_API_KEY || ""),
          API_KEY: JSON.stringify(env.GEMINI_API_KEY || ""),
        },
        browser: true,
        version: "v0.0.0",
      },
    },

    resolve: {
      alias: {
        "@": path.resolve(__dirname, "."),
      },
    },

    /**
     * Fix CJS deps
     */
    optimizeDeps: {
      include: ["ethers", "js-sha3", "tweetnacl"],
    },

    build: {
      chunkSizeWarningLimit: 1000,
    },
  };
});
