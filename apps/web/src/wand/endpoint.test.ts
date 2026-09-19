import { describe, expect, it } from "vitest";
import { VirtualWandEndpoint } from "./endpoint";
import {
  ALL_CAPABILITIES,
  CommandResultCode,
  ControlOpcode,
  CueEffect,
  HealthFlag,
  MotionFlag,
  PresentationPhase,
  ProtocolError,
  SpellCode,
  StatusKind,
  WAND_PROTOCOL_VERSION,
  decodeStatus,
  encodeControl,
  type CommandResultStatus,
  type InfoRecord,
  type MotionRecord,
  type StatusRecord,
} from "./protocol";

const INFO: InfoRecord = {
  version: WAND_PROTOCOL_VERSION,
  capabilities: ALL_CAPABILITIES,
  sampleHz: 50,
  rangeG: 8,
  deviceId: [0xa1, 0xb2, 0xc3, 0xd4, 0xe5, 0xf6],
  bootId: 0x1122_3344,
  firmware: { major: 0, minor: 1, patch: 0 },
  axisConvention: 1,
};

const NONCE = 0xaabb_ccdd;
const EPOCH = 0x0102_0304;

describe("VirtualWandEndpoint", () => {
  it("reports current health and emits motion only after subscription and OPEN", () => {
    const fixture = endpointAt(1_010);
    expect(fixture.endpoint.emitMotion(motion())).toBe(false);

    const initial = decodeStatus(fixture.endpoint.readStatus());
    expect(initial).toEqual({
      version: WAND_PROTOCOL_VERSION,
      kind: StatusKind.Health,
      commandSeq: 0,
      linkNonce: 0,
      deviceMs: 1_010,
      droppedCount: 0,
      healthFlags:
        HealthFlag.SensorHealthy |
        HealthFlag.PresentationHealthy |
        HealthFlag.HostStateStale,
    });

    const motionPackets: Uint8Array[] = [];
    const statuses = collectStatuses(fixture.endpoint);
    fixture.endpoint.subscribeMotion((bytes) => motionPackets.push(bytes));
    fixture.endpoint.writeControl(open());

    expect(commandResults(statuses)[0]).toMatchObject({
      commandSeq: 0,
      linkNonce: NONCE,
      deviceMs: 1_010,
      opcode: ControlOpcode.Open,
      resultCode: CommandResultCode.Ok,
    });
    expect(fixture.endpoint.emitMotion(motion())).toBe(true);
    expect(motionPackets).toHaveLength(1);

    const current = decodeStatus(fixture.endpoint.readStatus());
    expect(current.kind).toBe(StatusKind.Health);
    expect(current).toMatchObject({
      linkNonce: NONCE,
      healthFlags:
        HealthFlag.SensorHealthy |
        HealthFlag.StreamEnabled |
        HealthFlag.PresentationHealthy |
        HealthFlag.HostStateStale,
    });
  });

  it("re-ACKs an identical OPEN without changing its receipt time", () => {
    const fixture = endpointAt(1_010);
    const statuses = collectStatuses(fixture.endpoint);
    const bytes = open();
    fixture.endpoint.writeControl(bytes);

    fixture.now.value = 1_100;
    fixture.endpoint.writeControl(bytes);
    const changed = bytes.slice();
    changed[8] = 1;
    fixture.endpoint.writeControl(changed);

    const results = commandResults(statuses);
    expect(results.map((result) => result.resultCode)).toEqual([
      CommandResultCode.Ok,
      CommandResultCode.Ok,
      CommandResultCode.StaleOrConflictingSequence,
    ]);
    expect(results[1].deviceMs).toBe(1_010);
    expect(results[2].deviceMs).toBe(1_100);
  });

  it("treats OPEN as stale after a newer command has been processed", () => {
    const fixture = endpointAt(1_010);
    const statuses = collectStatuses(fixture.endpoint);
    const openBytes = open();
    fixture.endpoint.writeControl(openBytes);
    fixture.endpoint.writeControl(sync(1));
    fixture.endpoint.writeControl(openBytes);

    expect(commandResults(statuses).slice(-1)).toMatchObject([
      {
        commandSeq: 0,
        opcode: ControlOpcode.Open,
        resultCode: CommandResultCode.StaleOrConflictingSequence,
      },
    ]);
  });

  it("applies state and a cue once, then expires both without timers", () => {
    const fixture = endpointAt(1_010);
    const statuses = collectStatuses(fixture.endpoint);
    fixture.endpoint.writeControl(open());

    fixture.now.value = 1_100;
    fixture.endpoint.writeControl(state(1, 2_200));
    fixture.now.value = 1_150;
    const cueBytes = cue(2, 1_400);
    fixture.endpoint.writeControl(cueBytes);
    expect(fixture.endpoint.getPresentation()).toMatchObject({
      state: {
        phase: PresentationPhase.Playing,
        hp: 100,
        presentationEpoch: EPOCH,
      },
      cue: {
        effect: CueEffect.AcceptedCast,
        spell: SpellCode.Stupefy,
        endsAtMs: 1_450,
      },
      cueRevision: 1,
    });

    fixture.now.value = 1_200;
    fixture.endpoint.writeControl(cueBytes);
    expect(fixture.endpoint.getPresentation().cueRevision).toBe(1);
    const cueResults = commandResults(statuses).filter(
      (result) => result.opcode === ControlOpcode.Cue,
    );
    expect(cueResults).toHaveLength(2);
    expect(cueResults[1].deviceMs).toBe(1_150);

    fixture.now.value = 2_200;
    fixture.endpoint.tick();
    expect(fixture.endpoint.getPresentation()).toEqual({
      state: null,
      cue: null,
      cueRevision: 1,
    });
    expect(decodeStatus(fixture.endpoint.readStatus())).toMatchObject({
      kind: StatusKind.Health,
      healthFlags:
        HealthFlag.SensorHealthy |
        HealthFlag.PresentationHealthy |
        HealthFlag.HostStateStale,
    });
  });

  it("rejects a cue at its end-exclusive deadline and consumes its sequence", () => {
    const fixture = endpointAt(1_000);
    const statuses = collectStatuses(fixture.endpoint);
    fixture.endpoint.writeControl(open());
    fixture.now.value = 1_100;
    fixture.endpoint.writeControl(state(1, 2_200));

    fixture.now.value = 1_400;
    fixture.endpoint.writeControl(cue(2, 1_400));
    fixture.endpoint.writeControl(sync(3));

    expect(commandResults(statuses).slice(-2)).toMatchObject([
      {
        commandSeq: 2,
        resultCode: CommandResultCode.Expired,
      },
      {
        commandSeq: 3,
        resultCode: CommandResultCode.Ok,
      },
    ]);
    expect(fixture.endpoint.getPresentation().cue).toBeNull();
  });

  it("rejects expired or overlong state leases and accepts the exact cap", () => {
    const fixture = endpointAt(1_100);
    const statuses = collectStatuses(fixture.endpoint);
    fixture.endpoint.writeControl(open());
    fixture.endpoint.writeControl(state(1, 1_100));
    fixture.endpoint.writeControl(state(2, 2_601));
    fixture.endpoint.writeControl(state(3, 2_600));

    expect(commandResults(statuses).slice(-3)).toMatchObject([
      { commandSeq: 1, resultCode: CommandResultCode.Expired },
      { commandSeq: 2, resultCode: CommandResultCode.Expired },
      { commandSeq: 3, resultCode: CommandResultCode.Ok },
    ]);
    expect(fixture.endpoint.getPresentation().state).toMatchObject({
      validUntilMs: 2_600,
    });
    expect(decodeStatus(fixture.endpoint.readStatus())).toMatchObject({
      kind: StatusKind.Health,
      healthFlags:
        HealthFlag.SensorHealthy | HealthFlag.PresentationHealthy,
    });
  });

  it("allows forward gaps and uint16 wrap while rejecting stale commands", () => {
    const fixture = endpointAt(2_000);
    const statuses = collectStatuses(fixture.endpoint);
    fixture.endpoint.writeControl(open());
    fixture.endpoint.writeControl(sync(2));
    fixture.endpoint.writeControl(sync(4));
    fixture.endpoint.writeControl(sync(3));

    expect(commandResults(statuses).map((result) => result.resultCode)).toEqual([
      CommandResultCode.Ok,
      CommandResultCode.Ok,
      CommandResultCode.Ok,
      CommandResultCode.StaleOrConflictingSequence,
    ]);

    const wrapFixture = endpointAt(2_100);
    const wrapStatuses = collectStatuses(wrapFixture.endpoint);
    wrapFixture.endpoint.writeControl(open());
    for (const seq of [0x7fff, 0xfffe, 0xffff, 0]) {
      wrapFixture.endpoint.writeControl(sync(seq));
    }
    expect(
      commandResults(wrapStatuses).map((result) => result.resultCode),
    ).toEqual([
      CommandResultCode.Ok,
      CommandResultCode.Ok,
      CommandResultCode.Ok,
      CommandResultCode.Ok,
      CommandResultCode.Ok,
    ]);
  });

  it("requires a result state before accepting a result cue", () => {
    const fixture = endpointAt(1_000);
    const statuses = collectStatuses(fixture.endpoint);
    fixture.endpoint.writeControl(open());
    fixture.endpoint.writeControl(state(1, 2_000));
    fixture.endpoint.writeControl(
      cue(2, 1_300, CueEffect.RoundResult, SpellCode.None),
    );
    fixture.endpoint.writeControl(
      state(3, 2_000, PresentationPhase.Won, 25),
    );
    fixture.endpoint.writeControl(
      cue(4, 1_300, CueEffect.RoundResult, SpellCode.None),
    );

    expect(commandResults(statuses).slice(-3)).toMatchObject([
      { commandSeq: 2, resultCode: CommandResultCode.InvalidArgument },
      { commandSeq: 3, resultCode: CommandResultCode.Ok },
      { commandSeq: 4, resultCode: CommandResultCode.Ok },
    ]);
    expect(fixture.endpoint.getPresentation().cue).toMatchObject({
      effect: CueEffect.RoundResult,
      spell: SpellCode.None,
    });
  });

  it("rejects a mismatched cue epoch and clears cues on a new state epoch", () => {
    const fixture = endpointAt(1_000);
    const statuses = collectStatuses(fixture.endpoint);
    fixture.endpoint.writeControl(open());
    fixture.endpoint.writeControl(state(1, 2_000));
    fixture.endpoint.writeControl(cue(2, 1_300));
    fixture.endpoint.writeControl(
      cue(3, 1_300, CueEffect.AcceptedCast, SpellCode.Stupefy, EPOCH + 1),
    );

    expect(commandResults(statuses).slice(-1)).toMatchObject([
      { commandSeq: 3, resultCode: CommandResultCode.InvalidArgument },
    ]);
    expect(fixture.endpoint.getPresentation().cueRevision).toBe(1);
    expect(fixture.endpoint.getPresentation().cue).not.toBeNull();

    fixture.endpoint.writeControl(
      state(4, 2_000, PresentationPhase.Playing, 100, EPOCH + 1),
    );
    expect(fixture.endpoint.getPresentation()).toMatchObject({
      state: { presentationEpoch: EPOCH + 1 },
      cue: null,
      cueRevision: 1,
    });
  });

  it("keeps health readable, cumulative, and separate from command results", () => {
    const fixture = endpointAt(500);
    const statuses = collectStatuses(fixture.endpoint);
    fixture.endpoint.writeControl(open());
    fixture.endpoint.recordDroppedSamples(3);
    fixture.endpoint.setSensorHealthy(false);
    fixture.endpoint.setPresentationHealthy(false);

    const current = decodeStatus(fixture.endpoint.readStatus());
    expect(current).toEqual({
      version: WAND_PROTOCOL_VERSION,
      kind: StatusKind.Health,
      commandSeq: 0,
      linkNonce: NONCE,
      deviceMs: 500,
      droppedCount: 3,
      healthFlags: HealthFlag.HostStateStale,
    });
    expect(statuses.some((status) => status.kind === StatusKind.Health)).toBe(
      true,
    );
  });

  it("rejects unidentifiable writes and clears listeners on disconnect", () => {
    const fixture = endpointAt(100);
    const statuses = collectStatuses(fixture.endpoint);
    expect(() => fixture.endpoint.writeControl(new Uint8Array(19))).toThrow(
      ProtocolError,
    );
    fixture.endpoint.writeControl(open());
    fixture.endpoint.disconnect();
    fixture.endpoint.notifyHealth();
    expect(statuses).toHaveLength(2);
    expect(fixture.endpoint.getPresentation().state).toBeNull();
  });
});

function endpointAt(initialNow: number): {
  endpoint: VirtualWandEndpoint;
  now: { value: number };
} {
  const now = { value: initialNow };
  return {
    endpoint: new VirtualWandEndpoint({ info: INFO, nowMs: () => now.value }),
    now,
  };
}

function collectStatuses(endpoint: VirtualWandEndpoint): StatusRecord[] {
  const statuses: StatusRecord[] = [];
  endpoint.subscribeStatus((bytes) => statuses.push(decodeStatus(bytes)));
  return statuses;
}

function commandResults(statuses: StatusRecord[]): CommandResultStatus[] {
  return statuses.filter(
    (status): status is CommandResultStatus =>
      status.kind === StatusKind.CommandResult,
  );
}

function open(): Uint8Array {
  return encodeControl({
    version: WAND_PROTOCOL_VERSION,
    opcode: ControlOpcode.Open,
    commandSeq: 0,
    linkNonce: NONCE,
  });
}

function sync(commandSeq: number): Uint8Array {
  return encodeControl({
    version: WAND_PROTOCOL_VERSION,
    opcode: ControlOpcode.Sync,
    commandSeq,
    linkNonce: NONCE,
  });
}

function state(
  commandSeq: number,
  validUntilMs: number,
  phase = PresentationPhase.Playing,
  hp = 100,
  presentationEpoch = EPOCH,
): Uint8Array {
  return encodeControl({
    version: WAND_PROTOCOL_VERSION,
    opcode: ControlOpcode.SetState,
    commandSeq,
    linkNonce: NONCE,
    phase,
    hp,
    maxHp: 100,
    statusFlags: 0,
    presentationEpoch,
    validUntilMs,
  });
}

function cue(
  commandSeq: number,
  startBeforeMs: number,
  effect = CueEffect.AcceptedCast,
  spell = SpellCode.Stupefy,
  presentationEpoch = EPOCH,
): Uint8Array {
  return encodeControl({
    version: WAND_PROTOCOL_VERSION,
    opcode: ControlOpcode.Cue,
    commandSeq,
    linkNonce: NONCE,
    effect,
    spell,
    durationMs: 300,
    presentationEpoch,
    startBeforeMs,
  });
}

function motion(): MotionRecord {
  return {
    version: WAND_PROTOCOL_VERSION,
    flags: MotionFlag.Valid,
    seq: 42,
    captureMs: 1_000,
    bootId: INFO.bootId,
    axMg: -100,
    ayMg: 200,
    azMg: 1_000,
  };
}
