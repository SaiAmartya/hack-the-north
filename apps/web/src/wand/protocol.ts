export const WAND_PROTOCOL_VERSION = 1 as const;
export const WAND_RECORD_LENGTH = 20;

export const WAND_UUIDS = {
  service: "7f510000-1b15-4f0d-8f3c-8db47a812000",
  info: "7f510001-1b15-4f0d-8f3c-8db47a812000",
  motion: "7f510002-1b15-4f0d-8f3c-8db47a812000",
  control: "7f510003-1b15-4f0d-8f3c-8db47a812000",
  status: "7f510004-1b15-4f0d-8f3c-8db47a812000",
} as const;

export const MAX_STATE_LEASE_MS = 1_500;
export const MAX_CUE_START_AHEAD_MS = 500;
export const MAX_CUE_DURATION_MS = 1_000;

export enum CapabilityFlag {
  RawMotion = 1 << 0,
  StateFeedback = 1 << 1,
  CueFeedback = 1 << 2,
  ClockSync = 1 << 3,
}

export const ALL_CAPABILITIES =
  CapabilityFlag.RawMotion |
  CapabilityFlag.StateFeedback |
  CapabilityFlag.CueFeedback |
  CapabilityFlag.ClockSync;

export enum MotionFlag {
  Valid = 1 << 0,
  Saturated = 1 << 1,
  Discontinuity = 1 << 2,
}

export const ALL_MOTION_FLAGS =
  MotionFlag.Valid | MotionFlag.Saturated | MotionFlag.Discontinuity;

export enum ControlOpcode {
  Open = 1,
  Sync = 2,
  SetState = 3,
  Cue = 4,
}

export enum PresentationPhase {
  Connected = 0,
  Practice = 1,
  Countdown = 2,
  Playing = 3,
  Won = 4,
  Lost = 5,
  Draw = 6,
  Aborted = 7,
}

export enum StateStatusFlag {
  ShieldActive = 1 << 0,
  OffenseLocked = 1 << 1,
}

export const ALL_STATE_STATUS_FLAGS =
  StateStatusFlag.ShieldActive | StateStatusFlag.OffenseLocked;

export enum CueEffect {
  AcceptedCast = 1,
  BlockedIncomingHit = 2,
  TookDamage = 3,
  RoundResult = 4,
}

export enum SpellCode {
  None = 0,
  Stupefy = 1,
  Protego = 2,
  Expelliarmus = 3,
  Incendio = 4,
  Sectumsempra = 5,
  PetrificusTotalus = 6,
  ExpectoPatronum = 7,
}

export enum StatusKind {
  Health = 0,
  CommandResult = 1,
}

export enum CommandResultCode {
  Ok = 0,
  Malformed = 1,
  WrongSession = 2,
  InvalidArgument = 3,
  Expired = 4,
  Unsupported = 5,
  StaleOrConflictingSequence = 6,
}

export enum HealthFlag {
  SensorHealthy = 1 << 0,
  StreamEnabled = 1 << 1,
  PresentationHealthy = 1 << 2,
  HostStateStale = 1 << 3,
}

export const ALL_HEALTH_FLAGS =
  HealthFlag.SensorHealthy |
  HealthFlag.StreamEnabled |
  HealthFlag.PresentationHealthy |
  HealthFlag.HostStateStale;

export type DeviceId = readonly [number, number, number, number, number, number];

export type InfoRecord = {
  version: typeof WAND_PROTOCOL_VERSION;
  capabilities: number;
  sampleHz: number;
  rangeG: number;
  deviceId: DeviceId;
  bootId: number;
  firmware: {
    major: number;
    minor: number;
    patch: number;
  };
  axisConvention: number;
};

export type MotionRecord = {
  version: typeof WAND_PROTOCOL_VERSION;
  flags: number;
  seq: number;
  captureMs: number;
  bootId: number;
  axMg: number;
  ayMg: number;
  azMg: number;
};

type CommandHeader = {
  version: typeof WAND_PROTOCOL_VERSION;
  commandSeq: number;
  linkNonce: number;
};

export type OpenCommand = CommandHeader & {
  opcode: ControlOpcode.Open;
};

export type SyncCommand = CommandHeader & {
  opcode: ControlOpcode.Sync;
};

export type SetStateCommand = CommandHeader & {
  opcode: ControlOpcode.SetState;
  phase: PresentationPhase;
  hp: number;
  maxHp: number;
  statusFlags: number;
  presentationEpoch: number;
  validUntilMs: number;
};

export type CueCommand = CommandHeader & {
  opcode: ControlOpcode.Cue;
  effect: CueEffect;
  spell: SpellCode;
  durationMs: number;
  presentationEpoch: number;
  startBeforeMs: number;
};

export type ControlCommand =
  | OpenCommand
  | SyncCommand
  | SetStateCommand
  | CueCommand;

export type HealthStatus = {
  version: typeof WAND_PROTOCOL_VERSION;
  kind: StatusKind.Health;
  commandSeq: 0;
  linkNonce: number;
  deviceMs: number;
  droppedCount: number;
  healthFlags: number;
};

export type CommandResultStatus = {
  version: typeof WAND_PROTOCOL_VERSION;
  kind: StatusKind.CommandResult;
  commandSeq: number;
  linkNonce: number;
  deviceMs: number;
  opcode: number;
  resultCode: CommandResultCode;
};

export type StatusRecord = HealthStatus | CommandResultStatus;

export type ProtocolErrorCode =
  | "invalid-length"
  | "unsupported-version"
  | "reserved-bits"
  | "out-of-range"
  | "unsupported-value";

export class ProtocolError extends Error {
  readonly code: ProtocolErrorCode;

  constructor(code: ProtocolErrorCode, message: string) {
    super(message);
    this.name = "ProtocolError";
    this.code = code;
  }
}

export type SequenceOrder = "newer" | "duplicate" | "stale" | "ambiguous";

export function classifySequence16(next: number, previous: number): SequenceOrder {
  assertInteger("next sequence", next, 0, 0xffff);
  assertInteger("previous sequence", previous, 0, 0xffff);
  const delta = (next - previous + 0x1_0000) % 0x1_0000;
  if (delta === 0) {
    return "duplicate";
  }
  if (delta === 0x8000) {
    return "ambiguous";
  }
  return delta < 0x8000 ? "newer" : "stale";
}

export function unsignedDelta32(next: number, previous: number): number {
  assertInteger("next uint32", next, 0, 0xffff_ffff);
  assertInteger("previous uint32", previous, 0, 0xffff_ffff);
  return (next - previous + 0x1_0000_0000) % 0x1_0000_0000;
}

export function addUint32(value: number, amount: number): number {
  assertInteger("uint32 value", value, 0, 0xffff_ffff);
  assertInteger("uint32 amount", amount, 0, 0xffff_ffff);
  return (value + amount) % 0x1_0000_0000;
}

export function isFutureWithin32(
  deadline: number,
  now: number,
  maxAheadMs: number,
): boolean {
  assertInteger("deadline", deadline, 0, 0xffff_ffff);
  assertInteger("now", now, 0, 0xffff_ffff);
  assertInteger("maximum future interval", maxAheadMs, 1, 0x7fff_ffff);
  const delta = unsignedDelta32(deadline, now);
  return delta > 0 && delta < 0x8000_0000 && delta <= maxAheadMs;
}

export function isSupportedDuelProfile(info: InfoRecord): boolean {
  return (
    info.capabilities === ALL_CAPABILITIES &&
    info.sampleHz === 50 &&
    (info.rangeG === 8 || info.rangeG === 2) &&
    info.axisConvention === 1
  );
}

/** Twelve lowercase hex digits in byte order; the referee compares this exact string. */
export function formatDeviceId(deviceId: DeviceId): string {
  assertDeviceId(deviceId);
  return Array.from(deviceId, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function encodeInfo(record: InfoRecord): Uint8Array {
  assertVersion(record.version);
  assertFlagMask("capabilities", record.capabilities, ALL_CAPABILITIES);
  assertInteger("sampleHz", record.sampleHz, 1, 0xff);
  assertInteger("rangeG", record.rangeG, 1, 0xff);
  assertDeviceId(record.deviceId);
  assertNonzeroUint32("bootId", record.bootId);
  assertInteger("firmware.major", record.firmware.major, 0, 0xff);
  assertInteger("firmware.minor", record.firmware.minor, 0, 0xff);
  assertInteger("firmware.patch", record.firmware.patch, 0, 0xff);
  assertInteger("axisConvention", record.axisConvention, 0, 0xff);

  const bytes = new Uint8Array(WAND_RECORD_LENGTH);
  const view = dataView(bytes);
  bytes[0] = record.version;
  bytes[1] = record.capabilities;
  bytes[2] = record.sampleHz;
  bytes[3] = record.rangeG;
  bytes.set(record.deviceId, 4);
  view.setUint32(10, record.bootId, true);
  bytes[14] = record.firmware.major;
  bytes[15] = record.firmware.minor;
  bytes[16] = record.firmware.patch;
  bytes[17] = record.axisConvention;
  return bytes;
}

export function decodeInfo(bytes: Uint8Array): InfoRecord {
  assertRecord(bytes);
  assertVersion(bytes[0]);
  assertFlagMask("capabilities", bytes[1], ALL_CAPABILITIES);
  assertInteger("sampleHz", bytes[2], 1, 0xff);
  assertInteger("rangeG", bytes[3], 1, 0xff);
  assertReservedZero(bytes, 18, 20);
  const view = dataView(bytes);
  const bootId = view.getUint32(10, true);
  assertNonzeroUint32("bootId", bootId);

  return {
    version: WAND_PROTOCOL_VERSION,
    capabilities: bytes[1],
    sampleHz: bytes[2],
    rangeG: bytes[3],
    deviceId: [bytes[4], bytes[5], bytes[6], bytes[7], bytes[8], bytes[9]],
    bootId,
    firmware: { major: bytes[14], minor: bytes[15], patch: bytes[16] },
    axisConvention: bytes[17],
  };
}

export function encodeMotion(record: MotionRecord): Uint8Array {
  assertVersion(record.version);
  assertFlagMask("motion flags", record.flags, ALL_MOTION_FLAGS);
  assertInteger("seq", record.seq, 0, 0xffff);
  assertInteger("captureMs", record.captureMs, 0, 0xffff_ffff);
  assertNonzeroUint32("bootId", record.bootId);
  assertMotionAxis("axMg", record.axMg);
  assertMotionAxis("ayMg", record.ayMg);
  assertMotionAxis("azMg", record.azMg);

  const bytes = new Uint8Array(WAND_RECORD_LENGTH);
  const view = dataView(bytes);
  bytes[0] = record.version;
  bytes[1] = record.flags;
  view.setUint16(2, record.seq, true);
  view.setUint32(4, record.captureMs, true);
  view.setUint32(8, record.bootId, true);
  view.setInt16(12, record.axMg, true);
  view.setInt16(14, record.ayMg, true);
  view.setInt16(16, record.azMg, true);
  return bytes;
}

export function decodeMotion(bytes: Uint8Array): MotionRecord {
  assertRecord(bytes);
  assertVersion(bytes[0]);
  assertFlagMask("motion flags", bytes[1], ALL_MOTION_FLAGS);
  assertReservedZero(bytes, 18, 20);
  const view = dataView(bytes);
  const bootId = view.getUint32(8, true);
  const axMg = view.getInt16(12, true);
  const ayMg = view.getInt16(14, true);
  const azMg = view.getInt16(16, true);
  assertNonzeroUint32("bootId", bootId);
  assertMotionAxis("axMg", axMg);
  assertMotionAxis("ayMg", ayMg);
  assertMotionAxis("azMg", azMg);

  return {
    version: WAND_PROTOCOL_VERSION,
    flags: bytes[1],
    seq: view.getUint16(2, true),
    captureMs: view.getUint32(4, true),
    bootId,
    axMg,
    ayMg,
    azMg,
  };
}

export function encodeControl(command: ControlCommand): Uint8Array {
  validateCommandHeader(command);
  const bytes = new Uint8Array(WAND_RECORD_LENGTH);
  const view = dataView(bytes);
  bytes[0] = command.version;
  bytes[1] = command.opcode;
  view.setUint16(2, command.commandSeq, true);
  view.setUint32(4, command.linkNonce, true);

  switch (command.opcode) {
    case ControlOpcode.Open:
      if (command.commandSeq !== 0) {
        throw rangeError("OPEN commandSeq must be zero");
      }
      break;
    case ControlOpcode.Sync:
      break;
    case ControlOpcode.SetState:
      validateSetState(command);
      view.setUint32(
        8,
        command.phase |
          (command.hp << 8) |
          (command.maxHp << 16) |
          (command.statusFlags << 24),
        true,
      );
      view.setUint32(12, command.presentationEpoch, true);
      view.setUint32(16, command.validUntilMs, true);
      break;
    case ControlOpcode.Cue:
      validateCue(command);
      view.setUint32(
        8,
        command.effect | (command.spell << 8) | (command.durationMs << 16),
        true,
      );
      view.setUint32(12, command.presentationEpoch, true);
      view.setUint32(16, command.startBeforeMs, true);
      break;
  }
  return bytes;
}

export function decodeControl(bytes: Uint8Array): ControlCommand {
  assertRecord(bytes);
  assertVersion(bytes[0]);
  const view = dataView(bytes);
  const opcode = bytes[1];
  const commandSeq = view.getUint16(2, true);
  const linkNonce = view.getUint32(4, true);
  assertNonzeroUint32("linkNonce", linkNonce);

  switch (opcode) {
    case ControlOpcode.Open:
      assertZeroArguments(view, "OPEN");
      if (commandSeq !== 0) {
        throw rangeError("OPEN commandSeq must be zero");
      }
      return {
        version: WAND_PROTOCOL_VERSION,
        opcode,
        commandSeq,
        linkNonce,
      };
    case ControlOpcode.Sync:
      assertZeroArguments(view, "SYNC");
      return {
        version: WAND_PROTOCOL_VERSION,
        opcode,
        commandSeq,
        linkNonce,
      };
    case ControlOpcode.SetState: {
      const arg0 = view.getUint32(8, true);
      const command: SetStateCommand = {
        version: WAND_PROTOCOL_VERSION,
        opcode,
        commandSeq,
        linkNonce,
        phase: arg0 & 0xff,
        hp: (arg0 >>> 8) & 0xff,
        maxHp: (arg0 >>> 16) & 0xff,
        statusFlags: (arg0 >>> 24) & 0xff,
        presentationEpoch: view.getUint32(12, true),
        validUntilMs: view.getUint32(16, true),
      };
      validateSetState(command);
      return command;
    }
    case ControlOpcode.Cue: {
      const arg0 = view.getUint32(8, true);
      const command: CueCommand = {
        version: WAND_PROTOCOL_VERSION,
        opcode,
        commandSeq,
        linkNonce,
        effect: arg0 & 0xff,
        spell: (arg0 >>> 8) & 0xff,
        durationMs: (arg0 >>> 16) & 0xffff,
        presentationEpoch: view.getUint32(12, true),
        startBeforeMs: view.getUint32(16, true),
      };
      validateCue(command);
      return command;
    }
    default:
      throw new ProtocolError(
        "unsupported-value",
        `unsupported CONTROL opcode ${opcode}`,
      );
  }
}

export function encodeStatus(status: StatusRecord): Uint8Array {
  assertVersion(status.version);
  const bytes = new Uint8Array(WAND_RECORD_LENGTH);
  const view = dataView(bytes);
  bytes[0] = status.version;
  bytes[1] = status.kind;
  view.setUint16(2, status.commandSeq, true);
  assertInteger("linkNonce", status.linkNonce, 0, 0xffff_ffff);
  assertInteger("deviceMs", status.deviceMs, 0, 0xffff_ffff);
  view.setUint32(4, status.linkNonce, true);
  view.setUint32(8, status.deviceMs, true);

  switch (status.kind) {
    case StatusKind.Health:
      if (status.commandSeq !== 0) {
        throw rangeError("health commandSeq must be zero");
      }
      assertInteger("droppedCount", status.droppedCount, 0, 0xffff_ffff);
      assertFlagMask("health flags", status.healthFlags, ALL_HEALTH_FLAGS);
      view.setUint32(12, status.droppedCount, true);
      view.setUint32(16, status.healthFlags, true);
      break;
    case StatusKind.CommandResult:
      assertInteger("commandSeq", status.commandSeq, 0, 0xffff);
      assertInteger("opcode", status.opcode, 0, 0xff);
      assertEnumValue(
        "resultCode",
        status.resultCode,
        CommandResultCode.Ok,
        CommandResultCode.StaleOrConflictingSequence,
      );
      view.setUint32(12, status.opcode, true);
      view.setUint32(16, status.resultCode, true);
      break;
  }
  return bytes;
}

export function decodeStatus(bytes: Uint8Array): StatusRecord {
  assertRecord(bytes);
  assertVersion(bytes[0]);
  const view = dataView(bytes);
  const kind = bytes[1];
  const commandSeq = view.getUint16(2, true);
  const linkNonce = view.getUint32(4, true);
  const deviceMs = view.getUint32(8, true);
  const detail0 = view.getUint32(12, true);
  const detail1 = view.getUint32(16, true);

  if (kind === StatusKind.Health) {
    if (commandSeq !== 0) {
      throw rangeError("health commandSeq must be zero");
    }
    assertFlagMask("health flags", detail1, ALL_HEALTH_FLAGS);
    return {
      version: WAND_PROTOCOL_VERSION,
      kind,
      commandSeq: 0,
      linkNonce,
      deviceMs,
      droppedCount: detail0,
      healthFlags: detail1,
    };
  }

  if (kind === StatusKind.CommandResult) {
    if (detail0 > 0xff) {
      throw rangeError("result opcode must fit one byte");
    }
    assertEnumValue(
      "resultCode",
      detail1,
      CommandResultCode.Ok,
      CommandResultCode.StaleOrConflictingSequence,
    );
    return {
      version: WAND_PROTOCOL_VERSION,
      kind,
      commandSeq,
      linkNonce,
      deviceMs,
      opcode: detail0,
      resultCode: detail1,
    };
  }

  throw new ProtocolError("unsupported-value", `unsupported STATUS kind ${kind}`);
}

function validateCommandHeader(command: CommandHeader): void {
  assertVersion(command.version);
  assertInteger("commandSeq", command.commandSeq, 0, 0xffff);
  assertNonzeroUint32("linkNonce", command.linkNonce);
}

function validateSetState(command: SetStateCommand): void {
  assertEnumValue(
    "phase",
    command.phase,
    PresentationPhase.Connected,
    PresentationPhase.Aborted,
  );
  assertInteger("hp", command.hp, 0, 100);
  if (command.maxHp !== 100) {
    throw rangeError("maxHp must be 100");
  }
  assertFlagMask(
    "state status flags",
    command.statusFlags,
    ALL_STATE_STATUS_FLAGS,
  );
  assertNonzeroUint32("presentationEpoch", command.presentationEpoch);
  assertInteger("validUntilMs", command.validUntilMs, 0, 0xffff_ffff);
}

function validateCue(command: CueCommand): void {
  assertEnumValue(
    "effect",
    command.effect,
    CueEffect.AcceptedCast,
    CueEffect.RoundResult,
  );
  assertEnumValue("spell", command.spell, SpellCode.None, SpellCode.ExpectoPatronum);
  assertInteger("durationMs", command.durationMs, 1, MAX_CUE_DURATION_MS);
  assertNonzeroUint32("presentationEpoch", command.presentationEpoch);
  assertInteger("startBeforeMs", command.startBeforeMs, 0, 0xffff_ffff);

  if (
    command.effect === CueEffect.AcceptedCast &&
    command.spell === SpellCode.None
  ) {
    throw rangeError("accepted-cast cue requires a spell");
  }
  if (
    command.effect === CueEffect.RoundResult &&
    command.spell !== SpellCode.None
  ) {
    throw rangeError("round-result cue requires spell None");
  }
}

function assertRecord(bytes: Uint8Array): void {
  if (bytes.byteLength !== WAND_RECORD_LENGTH) {
    throw new ProtocolError(
      "invalid-length",
      `record must be exactly ${WAND_RECORD_LENGTH} bytes, got ${bytes.byteLength}`,
    );
  }
}

function assertVersion(version: number): asserts version is 1 {
  if (version !== WAND_PROTOCOL_VERSION) {
    throw new ProtocolError(
      "unsupported-version",
      `unsupported protocol version ${version}`,
    );
  }
}

function assertReservedZero(bytes: Uint8Array, start: number, end: number): void {
  for (let index = start; index < end; index += 1) {
    if (bytes[index] !== 0) {
      throw new ProtocolError(
        "reserved-bits",
        `reserved byte ${index} must be zero`,
      );
    }
  }
}

function assertZeroArguments(view: DataView, command: string): void {
  if (
    view.getUint32(8, true) !== 0 ||
    view.getUint32(12, true) !== 0 ||
    view.getUint32(16, true) !== 0
  ) {
    throw rangeError(`${command} arguments must all be zero`);
  }
}

function assertFlagMask(name: string, value: number, allowed: number): void {
  assertInteger(name, value, 0, 0xffff_ffff);
  if ((value & ~allowed) !== 0) {
    throw new ProtocolError(
      "reserved-bits",
      `${name} contains reserved bits: 0x${value.toString(16)}`,
    );
  }
}

function assertDeviceId(deviceId: DeviceId): void {
  if (deviceId.length !== 6) {
    throw rangeError("deviceId must contain exactly six bytes");
  }
  deviceId.forEach((byte, index) =>
    assertInteger(`deviceId[${index}]`, byte, 0, 0xff),
  );
}

function assertMotionAxis(name: string, value: number): void {
  assertInteger(name, value, -8_000, 8_000);
}

function assertNonzeroUint32(name: string, value: number): void {
  assertInteger(name, value, 1, 0xffff_ffff);
}

function assertEnumValue(
  name: string,
  value: number,
  minimum: number,
  maximum: number,
): void {
  assertInteger(name, value, minimum, maximum);
}

function assertInteger(
  name: string,
  value: number,
  minimum: number,
  maximum: number,
): void {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw rangeError(`${name} must be an integer in [${minimum}, ${maximum}]`);
  }
}

function rangeError(message: string): ProtocolError {
  return new ProtocolError("out-of-range", message);
}

function dataView(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}
