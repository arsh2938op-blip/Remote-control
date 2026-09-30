/**
 * Persistent settings + last-known robot address.
 *
 * Deliberately a plain JSON file rather than SQLite: it holds no secrets,
 * is trivially inspectable before a demo, and keeps the server dependency-light.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { dirname, resolve } from "node:path";

export interface StoredSettings {
  robotName: string;
  host: string | null;
  port: number;
  connectionMethod: "mdns" | "manual" | "demo";
  autoReconnect: boolean;
  motorSpeed: number;
  volume: number;
  demoMode: boolean;
  cameraEnabled: boolean;
}

export const DEFAULT_SETTINGS: StoredSettings = {
  robotName: "WALL-E",
  host: null,
  port: 8080,
  connectionMethod: "mdns",
  autoReconnect: true,
  motorSpeed: 0.6,
  volume: 0.7,
  demoMode: false,
  cameraEnabled: false,
};

export class SettingsStore {
  private readonly file: string;
  private data: StoredSettings;

  constructor(file: string) {
    this.file = file;
    this.data = { ...DEFAULT_SETTINGS, ...this.read() };
  }

  private read(): Partial<StoredSettings> {
    try {
      if (!existsSync(this.file)) return {};
      const parsed: unknown = JSON.parse(readFileSync(this.file, "utf8"));
      if (typeof parsed !== "object" || parsed === null) return {};
      return parsed as Partial<StoredSettings>;
    } catch {
      // A corrupt settings file must never stop the app from booting.
      return {};
    }
  }

  private persist(): void {
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      // Write-then-rename so a crash mid-write cannot truncate the file.
      const tmp = `${this.file}.tmp`;
      writeFileSync(tmp, JSON.stringify(this.data, null, 2), "utf8");
      renameSync(tmp, this.file);
    } catch (err) {
      console.error("[settings] failed to persist:", (err as Error).message);
    }
  }

  get(): StoredSettings {
    return { ...this.data };
  }

  update(patch: Partial<StoredSettings>): StoredSettings {
    const merged = { ...this.data, ...patch };
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined) delete (merged as Record<string, unknown>)[k];
    }
    this.data = merged;
    this.persist();
    return this.get();
  }
}

export function defaultSettingsFile(rootDir = process.cwd()): string {
  return resolve(rootDir, ".walle", "settings.json");
}
