import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  // Relative asset and data paths, so the build works from any host path.
  base: "./",
  envDir: "../..",
  server: { port: 5173 },
});
