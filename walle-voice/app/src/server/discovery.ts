/**
 * mDNS / DNS-SD discovery for WALL-E.
 *
 * The ESP32 advertises `_walle._tcp.local.` with a TXT record carrying its
 * identity. Browsers cannot do mDNS, so this runs in the companion server and
 * the result is pushed to the UI over the app WebSocket.
 */

import { Bonjour, type Service, type Browser } from "bonjour-service";
import { MDNS_SERVICE_TYPE, MDNS_SERVICE_PORT, type DiscoveredRobot } from "../shared/protocol.js";

export interface DiscoveryEvents {
  onFound: (robot: DiscoveredRobot) => void;
  onLost: (id: string) => void;
  onError: (err: Error) => void;
}

export class RobotDiscovery {
  private bonjour: Bonjour | null = null;
  private browser: Browser | null = null;
  private readonly found = new Map<string, DiscoveredRobot>();

  constructor(private readonly events: DiscoveryEvents) {}

  get robots(): DiscoveredRobot[] {
    return [...this.found.values()];
  }

  start(): void {
    if (this.bonjour) return;
    try {
      this.bonjour = new Bonjour();
      // The service type alone is matched; WALL-E's port is read from the
      // announcement so a non-default port still works.
      this.browser = this.bonjour.find(
        { type: MDNS_SERVICE_TYPE },
        (service) => this.handleService(service),
      );
    } catch (err) {
      // No mDNS (e.g. restricted network) is a normal condition, not fatal:
      // the user can always fall back to manual IP entry.
      this.events.onError(err as Error);
    }
  }

  private handleService(service: Service): void {
    const id = `${service.fqdn ?? service.name}`;
    const addresses = (service.addresses ?? []).filter((a) => !/^fe80:/i.test(a));
    const host = addresses[0] ?? service.host.replace(/\.$/, "");
    if (!host) return;

    const robot: DiscoveredRobot = {
      id,
      name: service.txt?.name ?? service.name ?? "WALL-E",
      host,
      port: service.port ?? MDNS_SERVICE_PORT,
      addresses,
      txt: service.txt,
    };
    this.found.set(id, robot);
    this.events.onFound(robot);
  }

  async browse(timeoutMs: number): Promise<DiscoveredRobot[]> {
    if (!this.browser) return [];
    return new Promise((done) => {
      let settled = false;
      let timer: NodeJS.Timeout;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        done(this.robots);
      };
      timer = setTimeout(finish, timeoutMs);
      // "up" fires once the first matching service has been seen.
      this.browser!.once("up", finish);
    });
  }

  stop(): void {
    try {
      this.browser?.stop();
      this.bonjour?.destroy();
    } catch {
      /* teardown is best-effort */
    }
    this.browser = null;
    this.bonjour = null;
    this.found.clear();
  }
}
