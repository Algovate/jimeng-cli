const entry = process.argv[1] || "";
const isMainModule = /(?:^|\/)index\.(?:js|cjs)$/.test(entry);

if (isMainModule) {
  console.error("[jimeng-cli] Local HTTP server has been removed. Use `jimeng` CLI or `jimeng-mcp` instead.");
  process.exit(1);
}

export {};
