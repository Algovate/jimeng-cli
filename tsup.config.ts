import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts", "src/cli/index.ts", "src/mcp/index.ts"],
  format: ["cjs", "esm"],
  sourcemap: true,
  dts: true,
  clean: true,
  esbuildOptions(options) {
    // login.ts uses import.meta.url to resolve a script path at runtime.
    // It's only loaded from ESM CLI entry points (bin → .js), so the CJS
    // output where import.meta.url is empty is never executed.
    options.logOverride = { "empty-import-meta": "silent" };
  },
});
