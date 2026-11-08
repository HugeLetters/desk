import { defineConfig } from "vite";
import solid from "vite-plugin-solid";

/** Builds the desk page into `dist/`, which the plugin serves: `bun install` runs it, `bun run page` watches. */
export default defineConfig({ plugins: [solid()], build: { outDir: "dist", emptyOutDir: true } });
