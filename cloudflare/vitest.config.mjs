import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

const migrations = await readD1Migrations(fileURLToPath(new URL("./migrations", import.meta.url)));

export default defineConfig({
  plugins: [
    cloudflareTest(async () => ({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: { TEST_MIGRATIONS: migrations }
      }
    }))
  ],
  test: {
    include: ["cloudflare/tests/**/*.test.js"],
    setupFiles: ["./cloudflare/tests/setup.js"]
  }
});
