import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { Bonjour } from "bonjour-service";
import { RobotDiscovery } from "../src/server/discovery.js";
import { MockRobot } from "../src/mock/mockRobot.js";
import type { DiscoveredRobot } from "../src/shared/protocol.js";

/**
 * mDNS availability depends on the host network stack, so these tests are
 * advisory: they report what the environment supports instead of failing a
 * build on a locked-down network. `describe.skipIf` keeps CI honest.
 */
const MDNS_AVAILABLE = process.env.WALLE_TEST_MDNS !== "0";

describe("RobotDiscovery", () => {
  it("returns an empty list when mDNS cannot start", async () => {
    const d = new RobotDiscovery({ onFound: () => {}, onLost: () => {}, onError: () => {} });
    // Constructing without a valid interface must not throw.
    expect(() => d.start()).not.toThrow();
    expect(d.robots).toEqual([]);
    d.stop();
  });

  it.skipIf(!MDNS_AVAILABLE)("finds a published WALL-E over mDNS", async () => {
    const robot = new MockRobot({ port: 0, host: "127.0.0.1", name: "WALL-E-TEST" });
    const port = await robot.start();
    const bonjour = new Bonjour();
    bonjour.publish({
      name: "WALL-E-TEST",
      type: "walle",
      port,
      txt: { name: "WALL-E-TEST", fw: "test" },
    });

    const discovery = new RobotDiscovery({ onFound: () => {}, onLost: () => {}, onError: () => {} });
    discovery.start();
    const found = await discovery.browse(4000);

    expect(found.length).toBeGreaterThan(0);
    const hit: DiscoveredRobot | undefined = found.find((r) => r.name === "WALL-E-TEST");
    expect(hit?.host).toBeTruthy();
    expect(hit?.port).toBe(port);

    discovery.stop();
    bonjour.destroy();
    await robot.stop();
  }, 20000);

  it.skipIf(!MDNS_AVAILABLE)("clears the list on stop", () => {
    const d = new RobotDiscovery({ onFound: () => {}, onLost: () => {}, onError: () => {} });
    d.start();
    d.stop();
    expect(d.robots).toEqual([]);
  });
});

describe("manual connection path", () => {
  let robot: MockRobot;
  let port: number;

  beforeAll(async () => {
    robot = new MockRobot({ port: 0, host: "127.0.0.1" });
    port = await robot.start();
  });

  afterAll(async () => {
    await robot.stop();
  });

  it("a manually addressed robot is reachable without any discovery", async () => {
    // Proves the IP + port path works independently of mDNS.
    const res = await fetch(`http://127.0.0.1:${port}/`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("WALL-E");
  });
});
