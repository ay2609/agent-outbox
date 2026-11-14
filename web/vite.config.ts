import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL(".", import.meta.url));

// Build: bunx vite build --config web/vite.config.ts  ->  web/dist (served by src/owner-api).
// Dev: bunx vite --config web/vite.config.ts, with the server on :7477 (bun run src/server.ts). Passkeys are bound to
// http://localhost:<port>, so for passkey work open http://localhost:7477 (the built dist), not :5173.
export default defineConfig({
  root,
  plugins: [react()],
  build: { outDir: "dist", emptyOutDir: true, target: "es2022", sourcemap: false },
  server: { port: 5173, proxy: { "/api": "http://127.0.0.1:7477" } },
});
