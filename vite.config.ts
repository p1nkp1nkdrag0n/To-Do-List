import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { legalAssetsPlugin } from "./scripts/legal-assets.mjs";

export default defineConfig({
  plugins: [react(), legalAssetsPlugin()],
  server: {
    port: 5173,
    proxy: {
      "/api": "http://localhost:4000",
      "/ws": {
        target: "ws://localhost:4000",
        ws: true,
      },
    },
  },
});
