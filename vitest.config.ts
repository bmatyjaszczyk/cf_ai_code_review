import { defineConfig } from "vitest/config";

// Unit tests cover the pure review logic and run in Node, without the Cloudflare plugin.
export default defineConfig({ test: { include: ["test/**/*.test.ts"] } });
