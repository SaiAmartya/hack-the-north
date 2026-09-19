import { WAND_UUIDS } from "./protocol";

export type NotificationKind = "motion" | "status";
export type ByteListener = (bytes: Uint8Array) => void;
export type TransportFailure = {
  code: string;
  message: string;
  recoverable: boolean;
};
export type DisconnectListener = (failure?: TransportFailure) => void;

export interface GattCharacteristic extends EventTarget {
  readonly value?: DataView;
  readValue(): Promise<DataView>;
  writeValueWithResponse(value: ArrayBuffer): Promise<void>;
  startNotifications(): Promise<GattCharacteristic>;
}
export interface GattService {
  getCharacteristic(uuid: string): Promise<GattCharacteristic>;
}
export interface GattServer {
  connect(): Promise<GattServer>;
  disconnect(): void;
  getPrimaryService(uuid: string): Promise<GattService>;
}
export interface BleDevice extends EventTarget {
  readonly id: string;
  readonly gatt?: GattServer;
}
export interface BluetoothAccess {
  requestDevice(options: RequestDeviceOptions): Promise<BleDevice>;
}

export interface WandTransport {
  readonly source: "REPLAY" | "REAL BLE" | "PHONE";
  connect(onDisconnect: DisconnectListener): Promise<void>;
  /** Resets a logical link, retaining only an already approved phone pairing. */
  recover?(onDisconnect: DisconnectListener): Promise<void>;
  /** Whether recover() has something to resume (a chosen badge, an approved pair). */
  canRecover?(): boolean;
  readInfo(): Promise<Uint8Array>;
  readStatus(): Promise<Uint8Array>;
  subscribe(kind: NotificationKind, listener: ByteListener): Promise<void>;
  writeControl(bytes: Uint8Array): Promise<void>;
  disconnect(): void;
}

const deviceOwners = new Map<string, symbol>();

const RECOVERY_ATTEMPTS = 4;
const RECOVERY_DELAYS_MS = [0, 500, 1000, 2000];

export class BleWandTransport implements WandTransport {
  readonly source = "REAL BLE";
  private generation = 0;
  private device?: BleDevice;
  private owner?: symbol;
  private service?: GattService;
  private tail: Promise<unknown> = Promise.resolve();
  private cleanup: (() => void)[] = [];
  /** The badge the player chose; kept across link loss so recovery needs no chooser. */
  private chosen?: BleDevice;

  constructor(
    private readonly bluetooth: BluetoothAccess,
    private readonly sleep: (ms: number) => Promise<void> = (ms) =>
      new Promise((resolve) => setTimeout(resolve, ms)),
  ) {}

  async connect(onDisconnect: DisconnectListener): Promise<void> {
    this.disconnect();
    this.chosen = undefined;
    const generation = this.generation;
    const device = await this.bluetooth.requestDevice({
      filters: [{ services: [WAND_UUIDS.service] }],
    });
    this.assertGeneration(generation);
    if (!device.gatt) throw new Error("Selected device has no GATT server");
    if (deviceOwners.has(device.id))
      throw new Error("Selected wand is already in use");
    this.chosen = device;
    await this.attach(device, generation, onDisconnect);
  }

  /**
   * Bounded automatic carrier recovery for the badge the player already chose: no chooser, a
   * fresh GATT link (or the still-open one), then the client performs a full new handshake.
   */
  readonly canRecover = (): boolean => Boolean(this.chosen?.gatt);

  readonly recover = async (onDisconnect: DisconnectListener): Promise<void> => {
    const device = this.chosen;
    if (!device?.gatt) throw new Error("Choose your badge again.");
    this.disconnect();
    const generation = this.generation;
    let lastError: unknown;
    for (let attempt = 0; attempt < RECOVERY_ATTEMPTS; attempt++) {
      if (RECOVERY_DELAYS_MS[attempt]) await this.sleep(RECOVERY_DELAYS_MS[attempt]);
      this.assertGeneration(generation);
      if (deviceOwners.has(device.id)) throw new Error("Selected wand is already in use");
      try {
        await this.attach(device, generation, onDisconnect);
        return;
      } catch (error) {
        this.assertGeneration(generation);
        lastError = error;
      }
    }
    throw new Error(
      lastError instanceof Error && lastError.message
        ? `Badge connection lost: ${lastError.message}`
        : "Badge connection lost. Reconnect your badge.",
    );
  };

  private async attach(
    device: BleDevice,
    generation: number,
    onDisconnect: DisconnectListener,
  ): Promise<void> {
    const owner = Symbol("ble-wand-connection");
    deviceOwners.set(device.id, owner);
    this.device = device;
    this.owner = owner;
    let service: GattService;
    try {
      const server = await device.gatt!.connect();
      this.assertGeneration(generation);
      service = await server.getPrimaryService(WAND_UUIDS.service);
      this.assertGeneration(generation);
    } catch (error) {
      // Release without bumping the generation so a bounded retry can attach again.
      if (generation === this.generation) this.release();
      else disconnectStaleDevice(device, owner);
      throw error;
    }
    // A drop while attaching rejects the attach above and stays inside the retry loop; only a
    // link that reached service discovery reports loss to the client.
    const lost = () => {
      if (
        generation !== this.generation ||
        deviceOwners.get(device.id) !== owner
      )
        return;
      this.disconnect();
      onDisconnect({
        code: "device_disconnected",
        message: "Badge connection lost.",
        recoverable: true,
      });
    };
    device.addEventListener("gattserverdisconnected", lost);
    this.cleanup.push(() =>
      device.removeEventListener("gattserverdisconnected", lost),
    );
    this.service = service;
  }

  readInfo() {
    return this.read(WAND_UUIDS.info);
  }
  readStatus() {
    return this.read(WAND_UUIDS.status);
  }

  private read(uuid: string): Promise<Uint8Array> {
    return this.serial(async (service, generation) => {
      const characteristic = await service.getCharacteristic(uuid);
      this.assertGeneration(generation);
      const value = await characteristic.readValue();
      this.assertGeneration(generation);
      return new Uint8Array(
        value.buffer,
        value.byteOffset,
        value.byteLength,
      ).slice();
    });
  }

  subscribe(kind: NotificationKind, listener: ByteListener): Promise<void> {
    return this.serial(async (service, generation) => {
      const characteristic = await service.getCharacteristic(WAND_UUIDS[kind]);
      this.assertGeneration(generation);
      const changed = () => {
        if (generation !== this.generation || !characteristic.value) return;
        const value = characteristic.value;
        listener(
          new Uint8Array(
            value.buffer,
            value.byteOffset,
            value.byteLength,
          ).slice(),
        );
      };
      characteristic.addEventListener("characteristicvaluechanged", changed);
      this.cleanup.push(() =>
        characteristic.removeEventListener(
          "characteristicvaluechanged",
          changed,
        ),
      );
      await characteristic.startNotifications();
      this.assertGeneration(generation);
    });
  }

  writeControl(bytes: Uint8Array): Promise<void> {
    return this.serial(async (service, generation) => {
      const characteristic = await service.getCharacteristic(
        WAND_UUIDS.control,
      );
      this.assertGeneration(generation);
      await characteristic.writeValueWithResponse(
        Uint8Array.from(bytes).buffer,
      );
      this.assertGeneration(generation);
    });
  }

  disconnect(): void {
    this.generation++;
    this.release();
    this.tail = Promise.resolve();
  }

  private release(): void {
    for (const remove of this.cleanup.splice(0)) remove();
    this.service = undefined;
    if (this.device && this.owner)
      disconnectOwnedDevice(this.device, this.owner);
    this.device = undefined;
    this.owner = undefined;
  }

  private assertGeneration(generation: number): void {
    if (generation !== this.generation)
      throw new Error("Connection superseded");
  }

  private serial<T>(
    operation: (service: GattService, generation: number) => Promise<T>,
  ): Promise<T> {
    const generation = this.generation;
    const task = this.tail.then(() => {
      this.assertGeneration(generation);
      if (!this.service) throw new Error("Wand not connected");
      return operation(this.service, generation);
    });
    this.tail = task.catch(() => undefined);
    return task;
  }
}

function disconnectOwnedDevice(device: BleDevice, owner: symbol): void {
  if (deviceOwners.get(device.id) !== owner) return;
  deviceOwners.delete(device.id);
  device.gatt?.disconnect();
}

function disconnectStaleDevice(device: BleDevice, staleOwner: symbol): void {
  const currentOwner = deviceOwners.get(device.id);
  if (currentOwner !== undefined && currentOwner !== staleOwner) return;
  if (currentOwner === staleOwner) deviceOwners.delete(device.id);
  device.gatt?.disconnect();
}
