import { describe, expect, it } from "vitest";
import { localSpeechAllowed } from "../../dev/speech-proxy";
describe("speech proxy network boundary", () => {
  const origin = "https://192.168.1.20:5173",
    host = "192.168.1.20";
  it("allows only the laptop itself with the exact origin", () => {
    expect(localSpeechAllowed(origin, "127.0.0.1", origin, host)).toBe(true);
    expect(
      localSpeechAllowed(origin, "::ffff:192.168.1.20", origin, host),
    ).toBe(true);
    expect(localSpeechAllowed(origin, "192.168.1.21", origin, host)).toBe(
      false,
    );
    expect(
      localSpeechAllowed("https://evil.test", "127.0.0.1", origin, host),
    ).toBe(false);
    expect(localSpeechAllowed(undefined, "127.0.0.1", origin, host)).toBe(
      false,
    );
  });
});
