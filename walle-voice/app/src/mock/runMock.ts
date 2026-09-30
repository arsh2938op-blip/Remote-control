/**
 * Standalone launcher for the mock robot:
 *   npm run mock
 * Then point the app at 127.0.0.1:8080 (or enable demo mode) to drive it.
 */

import { DEFAULT_ROBOT_PORT } from "../shared/protocol.js";
import { MockRobot } from "./mockRobot.js";

const port = Number(process.env.MOCK_PORT ?? DEFAULT_ROBOT_PORT);
const advertise = process.env.MOCK_ADVERTISE === "1";

const robot = new MockRobot({ port, advertise: true });
const actual = await robot.start();

console.log(`WALL-E mock robot listening on ws://127.0.0.1:${actual}/`);
console.log(`  mDNS advertisement: ${advertise ? "on (_walle._tcp.local)" : "off (set MOCK_ADVERTISE=1)"}`);

const shutdown = async () => {
  await robot.stop();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
