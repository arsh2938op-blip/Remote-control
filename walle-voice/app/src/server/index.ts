import { loadConfig } from "./config.js";
import { createAppServer } from "./appServer.js";

const config = loadConfig();
const server = createAppServer(config);

await server.start();

const shutdown = async (signal: string) => {
  console.log(`\n${signal} received, shutting down…`);
  await server.stop();
  process.exit(0);
};

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
