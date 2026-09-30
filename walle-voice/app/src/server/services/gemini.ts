/**
 * Single source of truth for who is allowed to drive the robot.
 *
 * The API key lives only in the server process. `ask` is the one command that
 * requires it, and it is executed by the server rather than by the ESP32 so
 * the key never crosses the wire.
 */

import type { Command, RobotStatus } from "../../shared/protocol.js";

export interface GeminiResult {
  text: string;
  requestId?: string;
  model: string;
}

export class GeminiService {
  constructor(
    private readonly apiKey: string | undefined,
    private readonly model: string,
  ) {}

  get available(): boolean {
    return Boolean(this.apiKey);
  }

  /**
   * Returns a canned reply when no key is configured, so the demo and the
   * Innovation Day dry-run still work end to end.
   */
  async ask(prompt: string, context?: Partial<RobotStatus>): Promise<GeminiResult> {
    if (!this.apiKey) {
      return { text: this.canned(prompt), model: "offline-canned" };
    }
    const system = [
      "You are WALL-E, a small friendly waste-compacting robot built for an Innovation Day demo.",
      "Answer in at most two short sentences, spoken-friendly, no markdown, no emoji.",
      context?.state ? `Current state: ${context.state}.` : "",
    ]
      .filter(Boolean)
      .join(" ");

    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(this.model)}:generateContent?key=${encodeURIComponent(this.apiKey)}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: system }] },
          contents: [{ role: "user", parts: [{ text: prompt }] }],
          generationConfig: { maxOutputTokens: 160, temperature: 0.8 },
        }),
      },
    );

    if (!res.ok) {
      throw new Error(`Gemini API error ${res.status}: ${(await res.text()).slice(0, 200)}`);
    }
    const body = (await res.json()) as {
      candidates?: { content?: { parts?: { text?: string }[] } }[];
    };
    const text = body.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
    if (!text) throw new Error("Gemini returned an empty response");
    return { text, model: this.model };
  }

  /** Deterministic offline replies keep automated tests stable. */
  private canned(prompt: string): string {
    const p = prompt.toLowerCase();
    if (p.includes("joke")) return "Why did the robot cross the road? To reach the other charging station! Ha ha!";
    if (p.includes("name")) return "My name is WALL-E. I am a Wall-E, and I love to tidy things up!";
    if (p.includes("hello") || p.includes("hi ") || p === "hi") return "Hello! WALL-E here, ready to explore!";
    if (p.includes("who") && p.includes("are you")) return "I am WALL-E, a compacting robot with a camera and a curious mind!";
    if (p.includes("camera")) return "My camera is watching the floor so I do not bump into anything!";
    if (p.includes("autonomous")) return "Turn on Autonomous Mode and I will explore all by myself!";
    return "Beep boop! I heard you. WALL-E is online and ready to roll!";
  }
}

/** Commands the server answers itself instead of relaying to the ESP32. */
export function isServerHandled(cmd: Command): boolean {
  return cmd.command === "ask" || cmd.command === "get_status" || cmd.command === "ping";
}
