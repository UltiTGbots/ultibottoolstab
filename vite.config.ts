import path from "path";
import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");

  return {
    base: '/',
    server: {
      port: 3000,
      host: "0.0.0.0",
      proxy: {
        '/api': {
          target: env.VITE_API_BASE_URL || 'http://3.21.170.124:8787',
          changeOrigin: true,
        },
        '/socket.io': {
          target: env.VITE_SOCKET_BASE_URL || env.VITE_API_BASE_URL || 'http://3.21.170.124:8787',
          ws: true,
          changeOrigin: true,
        }
      }
    },

    plugins: [react()],

    /**
     * Provide ONLY what browser libraries expect
     */
    define: {
      global: "globalThis",
      process: {
        env: {},
        browser: true,
        version: "v0.0.0",
      },

      "process.env.GEMINI_API_KEY": JSON.stringify(env.GEMINI_API_KEY),
      "process.env.API_KEY": JSON.stringify(env.GEMINI_API_KEY),
    },

    resolve: {
      alias: {
        "@": path.resolve(__dirname, "."),
      },
    },

    /**
     * ✅ FIX: force Vite to pre-bundle tweetnacl (CommonJS)
     */
    optimizeDeps: {
      include: ["ethers", "js-sha3", "tweetnacl"],
    },

    build: {
      chunkSizeWarningLimit: 1000,
    },
  };
});
