import { defineConfig } from "vite";

const worker = "http://127.0.0.1:8787";

export default defineConfig({
  build: {
    outDir: "dist/client",
    emptyOutDir: true,
    target: "es2022"
  },
  server: {
    port: 5173,
    // Keys starting with "^" are regexes; plain prefixes like "/s" would also
    // match "/src/...", which made Vite proxy its own module requests to the
    // Worker and broke the dev server.
    proxy: {
      "^/api(/|$)": worker,
      "^/d/": worker,
      "^/v/": worker,
      "^/s/": worker
    }
  }
});
