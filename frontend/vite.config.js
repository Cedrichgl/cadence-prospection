import { defineConfig } from "vite";

// En développement, les appels /api sont relayés vers FastAPI (port 8000).
export default defineConfig({
  server: {
    proxy: { "/api": "http://localhost:8000" },
  },
});
