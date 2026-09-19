import { afterEach, expect, it, vi } from "vitest";
import { VirtualWandTransport } from "./virtual";
import {
  ControlOpcode,
  MotionFlag,
  decodeMotion,
  encodeControl,
} from "./protocol";

afterEach(() => vi.useRealTimers());

it("marks the first emission after endpoint-known drops as discontinuous", async () => {
  vi.useFakeTimers();
  const transport = new VirtualWandTransport(() => Date.now());
  try {
    await transport.connect(() => {});
    const records: ReturnType<typeof decodeMotion>[] = [];
    await transport.subscribe("motion", (bytes) =>
      records.push(decodeMotion(bytes)),
    );
    await transport.writeControl(
      encodeControl({
        version: 1,
        opcode: ControlOpcode.Open,
        commandSeq: 0,
        linkNonce: 123,
      }),
    );
    await vi.advanceTimersByTimeAsync(40);
    expect(records).toHaveLength(2);
    transport.injectOutage();
    await vi.advanceTimersByTimeAsync(620);
    expect(records).toHaveLength(4);
    expect(records[2].flags).toBe(MotionFlag.Valid | MotionFlag.Discontinuity);
    expect(records[3].flags).toBe(MotionFlag.Valid);
    expect(records[2].seq - records[1].seq).toBeGreaterThan(1);
  } finally {
    transport.disconnect();
  }
});
