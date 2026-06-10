import path from "node:path";
import { defineConfig } from "vitest/config";

const root = import.meta.dirname;

export default defineConfig({
  resolve: {
    alias: {
      "@routecast/pricing": path.resolve(root, "packages/pricing/src/index.ts"),
      "@routecast/core": path.resolve(root, "packages/core/src/index.ts"),
      "@routecast/mcp": path.resolve(root, "packages/mcp/src/index.ts"),
    },
  },
  test: {
    include: ["packages/*/test/**/*.test.ts"],
  },
});
