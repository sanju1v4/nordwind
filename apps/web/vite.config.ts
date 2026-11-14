import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // The browser talks only to localhost:5173; Vite forwards API calls to the API on :3000.
    // Same origin for the browser = cookies just work and no CORS is needed.
    // In production a load balancer / ingress does the same job.
    proxy: {
      "/trpc": "http://localhost:3000",
      "/auth": "http://localhost:3000",
    },
  },
});
