import { fileURLToPath, URL } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Build output lands at `src/ui/dist/`, served by warren's UI handler
// (`src/server/ui.ts`). The dev server proxies `/agents`, `/projects`,
// `/runs`, `/healthz`, `/readyz` to the warren API at :8080 so the SPA
// can run side-by-side with the API in development.
export default defineConfig({
	plugins: [react(), tailwindcss()],
	resolve: {
		alias: {
			"@": fileURLToPath(new URL("./src", import.meta.url)),
		},
	},
	server: {
		port: 5173,
		proxy: {
			"/agents": "http://127.0.0.1:8080",
			"/projects": "http://127.0.0.1:8080",
			"/runs": "http://127.0.0.1:8080",
			"/healthz": "http://127.0.0.1:8080",
			"/readyz": "http://127.0.0.1:8080",
		},
	},
	build: {
		outDir: "dist",
		emptyOutDir: true,
		sourcemap: false,
	},
});
