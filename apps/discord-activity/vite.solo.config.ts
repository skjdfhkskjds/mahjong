import { cloudflare } from "@cloudflare/vite-plugin";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";

import { soloWorkerConfig } from "./tooling/solo-play/solo-worker-config.js";

export default defineConfig(({ command }) => {
  if (command !== "serve") {
    throw new Error(
      "This isolated browser launcher only serves local development.",
    );
  }
  const worker = soloWorkerConfig(
    fileURLToPath(new URL("./wrangler.jsonc", import.meta.url)),
  );
  return {
    define: {
      "import.meta.env.VITE_ACTIVITY_MODE": JSON.stringify("mock"),
      "import.meta.env.VITE_API_BASE_URL": JSON.stringify(""),
    },
    server: { host: "127.0.0.1" },
    plugins: [
      react(),
      cloudflare({
        configPath: worker.path,
        persistState: false,
        inspectorPort: false,
      }),
      { name: "solo-worker-cleanup", closeBundle: worker.dispose },
    ],
  };
});
