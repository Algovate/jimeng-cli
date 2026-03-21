import environment from "@/lib/environment.ts";
import config from "@/lib/config.ts";
import "@/lib/initialize.ts";
import server from "@/lib/server.ts";
import routes from "@/api/routes/index.ts";
import logger from "@/lib/logger.ts";
import tokenPool from "@/lib/session-pool.ts";

export async function startService(): Promise<void> {
  const startupTime = performance.now();

  logger.header();
  logger.info("<<<< jimeng-cli >>>>");
  logger.info("Version:", environment.package.version);
  logger.info("Process id:", process.pid);
  logger.info("Environment:", environment.env);
  logger.info("Service name:", config.service.name);

  await tokenPool.init();
  server.attachRoutes(routes);
  await server.listen();

  if (config.service.bindAddress) {
    logger.success("Service bind address:", config.service.bindAddress);
  }

  logger.success(
    `Service startup completed (${Math.floor(performance.now() - startupTime)}ms)`
  );
}
