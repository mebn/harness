import path from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import wails from "@wailsio/runtime/plugins/vite";

export default defineConfig({
  server: {
    host: "127.0.0.1",
    port: Number(process.env.WAILS_VITE_PORT) || 9245,
    strictPort: true,
  },
  resolve: {
    alias: {
      "@bindings": path.resolve(__dirname, "./bindings"),
      "@": path.resolve(__dirname, "./src"),
    },
  },
  build: { chunkSizeWarningLimit: 2000 },
  plugins: [react(), tailwindcss(), wails("./bindings")],
});
