import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The Vite dev server proxies /api and /ws to the Node companion server,
// so the browser always talks to one origin (no CORS, works on a phone too).
const serverTarget = process.env.WALLE_SERVER ?? "http://localhost:8787";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    host: true, // reachable from other devices on the LAN
    proxy: {
      "/api": { target: serverTarget, changeOrigin: true },
      "/ws": { target: serverTarget.replace(/^http/, "ws"), ws: true },
    },
  },
  build: {
    outDir: "dist/client",
    emptyOutDir: true,
  },
});
