import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
	plugins: [react()],
	build: {
		rollupOptions: {
			input: {
				app: fileURLToPath(new URL("./index.html", import.meta.url)),
				fixtures: fileURLToPath(new URL("./fixtures.html", import.meta.url)),
			},
		},
	},
	server: {
		port: 5173,
		proxy: {
			"/ws": { target: "ws://localhost:8787", ws: true },
			"/healthz": "http://localhost:8787",
			"/api": "http://localhost:8787",
		},
	},
});
