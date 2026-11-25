import { defineConfig } from "vite";

export default defineConfig({
  build: {
    outDir: "dist/client",
    emptyOutDir: true,
    target: "es2022"
  },
  server: {
    port: 5173,
    proxy: {
      "/api": "http://127.0.0.1:8787",
      "/d": "http://127.0.0.1:8787",
      "/v": "http://127.0.0.1:8787",
      "/s": "http://127.0.0.1:8787"
    }
  }
});
