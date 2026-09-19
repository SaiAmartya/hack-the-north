import {
  CapabilityFlag,
  CommandResultCode,
  ControlOpcode,
  CueEffect,
  HealthFlag,
  MAX_CUE_DURATION_MS,
  MAX_CUE_START_AHEAD_MS,
  MAX_STATE_LEASE_MS,
  PresentationPhase,
  ProtocolError,
  StatusKind,
  WAND_PROTOCOL_VERSION,
  WAND_RECORD_LENGTH,
  addUint32,
  classifySequence16,
  decodeControl,
  encodeInfo,
  encodeMotion,
  encodeStatus,
  isFutureWithin32,
  unsignedDelta32,
  type CommandResultStatus,
  type ControlCommand,
  type CueCommand,
  type HealthStatus,
  type InfoRecord,
  type MotionRecord,
  type SetStateCommand,
} from "./protocol";

export type WandNotificationListener = (value: Uint8Array) => void;
export type Unsubscribe = () => void;

export type PresentedState = Pick<
  SetStateCommand,
  | "phase"
  | "hp"
  | "maxHp"
  | "statusFlags"
  | "presentationEpoch"
  | "validUntilMs"
> & {
  acceptedAtMs: number;
};

export type PresentedCue = Pick<
  CueCommand,
  | "effect"
  | "spell"
  | "durationMs"
  | "presentationEpoch"
  | "startBeforeMs"
> & {
  acceptedAtMs: number;
  endsAtMs: number;
};

export type PresentationSnapshot = {
  state: PresentedState | null;
  cue: PresentedCue | null;
  cueRevision: number;
};

export type VirtualWandEndpointOptions = {
  info: InfoRecord;
  nowMs: () => number;
  sensorHealthy?: boolean;
  presentationHealthy?: boolean;
};

type CachedCommand = {
  bytes: Uint8Array;
  result: CommandResultStatus;
};

type CommandHeader = {
  version: number;
  opcode: number;
  commandSeq: number;
  linkNonce: number;
};

export class VirtualWandEndpoint {
  readonly info: InfoRecord;

  private readonly nowMs: () => number;
  private readonly infoBytes: Uint8Array;
  private readonly motionListeners = new Set<WandNotificationListener>();
  private readonly statusListeners = new Set<WandNotificationListener>();

  private activeNonce: number | null = null;
  private lastCommandSeq: number | null = null;
  private cachedCommand: CachedCommand | null = null;
  private sensorHealthy: boolean;
  private presentationHealthy: boolean;
  private hostStateStale = true;
  private droppedCount = 0;
  private state: PresentedState | null = null;
  private cue: PresentedCue | null = null;
  private cueRevision = 0;

  constructor(options: VirtualWandEndpointOptions) {
    this.infoBytes = encodeInfo(options.info);
    this.info = {
      ...options.info,
      deviceId: [...options.info.deviceId],
      firmware: { ...options.info.firmware },
    };
    this.nowMs = options.nowMs;
    this.sensorHealthy = options.sensorHealthy ?? true;
    this.presentationHealthy = options.presentationHealthy ?? true;
  }

  readInfo(): Uint8Array {
    return this.infoBytes.slice();
  }

  readStatus(): Uint8Array {
    const now = this.deviceNow();
    this.expirePresentation(now);
    return encodeStatus(this.healthStatus(now));
  }

  subscribeMotion(listener: WandNotificationListener): Unsubscribe {
    const wasEnabled = this.streamEnabled();
    this.motionListeners.add(listener);
    this.notifyStreamTransition(wasEnabled);
    return () => {
      const enabledBeforeRemoval = this.streamEnabled();
      this.motionListeners.delete(listener);
      this.notifyStreamTransition(enabledBeforeRemoval);
    };
  }

  subscribeStatus(listener: WandNotificationListener): Unsubscribe {
    this.statusListeners.add(listener);
    return () => {
      this.statusListeners.delete(listener);
    };
  }

  writeControl(bytes: Uint8Array): void {
    if (bytes.byteLength !== WAND_RECORD_LENGTH) {
      throw new ProtocolError(
        "invalid-length",
        `CONTROL must be exactly ${WAND_RECORD_LENGTH} bytes`,
      );
    }

    const now = this.deviceNow();
    this.expirePresentation(now);
    const header = readCommandHeader(bytes);

    if (header.version !== WAND_PROTOCOL_VERSION) {
      this.notifyResult(
        this.commandResult(header, now, CommandResultCode.Malformed),
      );
      return;
    }

    if (this.activeNonce === null) {
      this.handleBeforeOpen(bytes, header, now);
      return;
    }

    if (header.linkNonce !== this.activeNonce) {
      this.notifyResult(
        this.commandResult(header, now, CommandResultCode.WrongSession),
      );
      return;
    }

    const order = classifySequence16(header.commandSeq, this.lastCommandSeq ?? 0);
    if (order === "duplicate") {
      if (
        this.cachedCommand !== null &&
        equalBytes(bytes, this.cachedCommand.bytes)
      ) {
        this.notifyResult(this.cachedCommand.result);
      } else {
        this.notifyResult(
          this.commandResult(
            header,
            now,
            CommandResultCode.StaleOrConflictingSequence,
          ),
        );
      }
      return;
    }
    if (order !== "newer") {
      this.notifyResult(
        this.commandResult(
          header,
          now,
          CommandResultCode.StaleOrConflictingSequence,
        ),
      );
      return;
    }

    const decoded = this.tryDecodeCommand(bytes, header, now);
    if (decoded === null) {
      return;
    }

    const resultCode = this.applyCommand(decoded, now);
    const result = this.commandResult(header, now, resultCode);
    this.lastCommandSeq = header.commandSeq;
    this.cachedCommand = { bytes: bytes.slice(), result };
    this.notifyResult(result);
  }

  emitMotion(record: MotionRecord): boolean {
    const now = this.deviceNow();
    this.expirePresentation(now);
    if (
      this.activeNonce === null ||
      !this.hasCapability(CapabilityFlag.RawMotion) ||
      this.motionListeners.size === 0
    ) {
      return false;
    }
    if (record.bootId !== this.info.bootId) {
      throw new ProtocolError(
        "out-of-range",
        "MOTION bootId must match the endpoint INFO bootId",
      );
    }
    this.notify(this.motionListeners, encodeMotion(record));
    return true;
  }

  tick(): void {
    this.expirePresentation(this.deviceNow());
  }

  notifyHealth(): void {
    const now = this.deviceNow();
    this.expirePresentation(now);
    this.notify(this.statusListeners, encodeStatus(this.healthStatus(now)));
  }

  setSensorHealthy(healthy: boolean): void {
    this.expirePresentation(this.deviceNow());
    if (this.sensorHealthy === healthy) {
      return;
    }
    this.sensorHealthy = healthy;
    this.notifyHealth();
  }

  setPresentationHealthy(healthy: boolean): void {
    this.expirePresentation(this.deviceNow());
    if (this.presentationHealthy === healthy) {
      return;
    }
    this.presentationHealthy = healthy;
    this.notifyHealth();
  }

  recordDroppedSamples(count = 1): void {
    if (!Number.isInteger(count) || count <= 0) {
      throw new ProtocolError(
        "out-of-range",
        "dropped sample count must be a positive integer",
      );
    }
    this.droppedCount = Math.min(0xffff_ffff, this.droppedCount + count);
  }

  getPresentation(): PresentationSnapshot {
    this.expirePresentation(this.deviceNow());
    return {
      state: this.state === null ? null : { ...this.state },
      cue: this.cue === null ? null : { ...this.cue },
      cueRevision: this.cueRevision,
    };
  }

  disconnect(): void {
    this.activeNonce = null;
    this.lastCommandSeq = null;
    this.cachedCommand = null;
    this.clearPresentation();
    this.hostStateStale = true;
    this.motionListeners.clear();
    this.statusListeners.clear();
  }

  private handleBeforeOpen(
    bytes: Uint8Array,
    header: CommandHeader,
    now: number,
  ): void {
    if (header.opcode !== ControlOpcode.Open) {
      this.notifyResult(
        this.commandResult(header, now, CommandResultCode.WrongSession),
      );
      return;
    }

    let command: ControlCommand;
    try {
      command = decodeControl(bytes);
    } catch (error) {
      this.notifyResult(
        this.commandResult(
          header,
          now,
          resultCodeForDecodeError(asProtocolError(error)),
        ),
      );
      return;
    }

    this.activeNonce = command.linkNonce;
    this.lastCommandSeq = command.commandSeq;
    this.clearPresentation();
    this.hostStateStale = true;
    const result = this.commandResult(header, now, CommandResultCode.Ok);
    this.cachedCommand = { bytes: bytes.slice(), result };
    this.notifyResult(result);
    this.notifyHealth();
  }

  private tryDecodeCommand(
    bytes: Uint8Array,
    header: CommandHeader,
    now: number,
  ): ControlCommand | null {
    try {
      return decodeControl(bytes);
    } catch (error) {
      const result = this.commandResult(
        header,
        now,
        resultCodeForDecodeError(asProtocolError(error)),
      );
      this.lastCommandSeq = header.commandSeq;
      this.cachedCommand = { bytes: bytes.slice(), result };
      this.notifyResult(result);
      return null;
    }
  }

  private applyCommand(command: ControlCommand, now: number): CommandResultCode {
    switch (command.opcode) {
      case ControlOpcode.Open:
        return CommandResultCode.InvalidArgument;
      case ControlOpcode.Sync:
        return this.hasCapability(CapabilityFlag.ClockSync)
          ? CommandResultCode.Ok
          : CommandResultCode.Unsupported;
      case ControlOpcode.SetState:
        return this.applyState(command, now);
      case ControlOpcode.Cue:
        return this.applyCue(command, now);
    }
  }

  private applyState(
    command: SetStateCommand,
    now: number,
  ): CommandResultCode {
    if (!this.hasCapability(CapabilityFlag.StateFeedback)) {
      return CommandResultCode.Unsupported;
    }
    if (!isFutureWithin32(command.validUntilMs, now, MAX_STATE_LEASE_MS)) {
      return CommandResultCode.Expired;
    }

    if (
      this.state !== null &&
      this.state.presentationEpoch !== command.presentationEpoch
    ) {
      this.cue = null;
    }
    this.state = {
      phase: command.phase,
      hp: command.hp,
      maxHp: command.maxHp,
      statusFlags: command.statusFlags,
      presentationEpoch: command.presentationEpoch,
      validUntilMs: command.validUntilMs,
      acceptedAtMs: now,
    };
    const wasStale = this.hostStateStale;
    this.hostStateStale = false;
    if (wasStale) {
      this.notifyHealth();
    }
    return CommandResultCode.Ok;
  }

  private applyCue(command: CueCommand, now: number): CommandResultCode {
    if (!this.hasCapability(CapabilityFlag.CueFeedback)) {
      return CommandResultCode.Unsupported;
    }
    if (
      this.state === null ||
      !isFutureWithin32(this.state.validUntilMs, now, MAX_STATE_LEASE_MS)
    ) {
      return CommandResultCode.Expired;
    }
    if (command.presentationEpoch !== this.state.presentationEpoch) {
      return CommandResultCode.InvalidArgument;
    }
    if (!isFutureWithin32(command.startBeforeMs, now, MAX_CUE_START_AHEAD_MS)) {
      return CommandResultCode.Expired;
    }
    if (
      command.effect === CueEffect.RoundResult &&
      !isResultPhase(this.state.phase)
    ) {
      return CommandResultCode.InvalidArgument;
    }

    const stateRemainingMs = unsignedDelta32(this.state.validUntilMs, now);
    const effectiveDurationMs = Math.min(command.durationMs, stateRemainingMs);
    this.cue = {
      effect: command.effect,
      spell: command.spell,
      durationMs: command.durationMs,
      presentationEpoch: command.presentationEpoch,
      startBeforeMs: command.startBeforeMs,
      acceptedAtMs: now,
      endsAtMs: addUint32(now, effectiveDurationMs),
    };
    this.cueRevision += 1;
    return CommandResultCode.Ok;
  }

  private expirePresentation(now: number): void {
    if (
      this.state !== null &&
      !isFutureWithin32(this.state.validUntilMs, now, MAX_STATE_LEASE_MS)
    ) {
      this.clearPresentation();
      if (!this.hostStateStale) {
        this.hostStateStale = true;
        this.notify(this.statusListeners, encodeStatus(this.healthStatus(now)));
      }
      return;
    }

    if (
      this.cue !== null &&
      !isFutureWithin32(this.cue.endsAtMs, now, MAX_CUE_DURATION_MS)
    ) {
      this.cue = null;
    }
  }

  private clearPresentation(): void {
    this.state = null;
    this.cue = null;
  }

  private notifyStreamTransition(wasEnabled: boolean): void {
    if (wasEnabled !== this.streamEnabled()) {
      this.notifyHealth();
    }
  }

  private streamEnabled(): boolean {
    return this.activeNonce !== null && this.motionListeners.size > 0;
  }

  private hasCapability(capability: CapabilityFlag): boolean {
    return (this.info.capabilities & capability) !== 0;
  }

  private healthStatus(now: number): HealthStatus {
    let healthFlags = 0;
    if (this.sensorHealthy) {
      healthFlags |= HealthFlag.SensorHealthy;
    }
    if (this.streamEnabled()) {
      healthFlags |= HealthFlag.StreamEnabled;
    }
    if (this.presentationHealthy) {
      healthFlags |= HealthFlag.PresentationHealthy;
    }
    if (this.hostStateStale) {
      healthFlags |= HealthFlag.HostStateStale;
    }
    return {
      version: WAND_PROTOCOL_VERSION,
      kind: StatusKind.Health,
      commandSeq: 0,
      linkNonce: this.activeNonce ?? 0,
      deviceMs: now,
      droppedCount: this.droppedCount,
      healthFlags,
    };
  }

  private commandResult(
    header: CommandHeader,
    now: number,
    resultCode: CommandResultCode,
  ): CommandResultStatus {
    return {
      version: WAND_PROTOCOL_VERSION,
      kind: StatusKind.CommandResult,
      commandSeq: header.commandSeq,
      linkNonce: this.activeNonce ?? 0,
      deviceMs: now,
      opcode: header.opcode,
      resultCode,
    };
  }

  private notifyResult(result: CommandResultStatus): void {
    this.notify(this.statusListeners, encodeStatus(result));
  }

  private notify(
    listeners: ReadonlySet<WandNotificationListener>,
    bytes: Uint8Array,
  ): void {
    for (const listener of Array.from(listeners)) {
      listener(bytes.slice());
    }
  }

  private deviceNow(): number {
    const now = this.nowMs();
    if (!Number.isFinite(now) || now < 0) {
      throw new ProtocolError(
        "out-of-range",
        "endpoint clock must return a finite non-negative value",
      );
    }
    return Math.trunc(now) % 0x1_0000_0000;
  }
}

function readCommandHeader(bytes: Uint8Array): CommandHeader {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return {
    version: bytes[0],
    opcode: bytes[1],
    commandSeq: view.getUint16(2, true),
    linkNonce: view.getUint32(4, true),
  };
}

function resultCodeForDecodeError(error: ProtocolError): CommandResultCode {
  if (error.code === "unsupported-value") {
    return CommandResultCode.Unsupported;
  }
  return error.code === "unsupported-version" || error.code === "invalid-length"
    ? CommandResultCode.Malformed
    : CommandResultCode.InvalidArgument;
}

function asProtocolError(error: unknown): ProtocolError {
  if (error instanceof ProtocolError) {
    return error;
  }
  throw error;
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) {
    return false;
  }
  return left.every((byte, index) => byte === right[index]);
}

function isResultPhase(phase: PresentationPhase): boolean {
  return (
    phase === PresentationPhase.Won ||
    phase === PresentationPhase.Lost ||
    phase === PresentationPhase.Draw
  );
}
