// The web app (studio.andyssarchives.com): the same UI, built from web.html
// into dist-web, with web-public's service worker and manifest beside it.
//   npm run build:web       ·       npm run dev:web (http://localhost:1420/web.html)
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { renameSync } from "node:fs";

export default defineConfig({
  plugins: [
    react(),
    {
      // Served as the site's front page.
      name: "web-index",
      apply: "build",
      closeBundle() {
        renameSync("dist-web/web.html", "dist-web/index.html");
      },
    },
  ],
  mode: "web",
  publicDir: "web-public",
  build: { outDir: "dist-web", emptyOutDir: true, rollupOptions: { input: "web.html" } },
  server: { port: 1420, strictPort: true, watch: { ignored: ["**/src-tauri/**", "**/prototypes/**", "**/PROJECTS/**"] } },
});
