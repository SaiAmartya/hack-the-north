import { describe, expect, it, vi } from "vitest";
import {
  BleWandTransport,
  type GattCharacteristic,
  type GattServer,
  type GattService,
  type BleDevice,
} from "./transport";
import { WAND_UUIDS } from "./protocol";

class Characteristic extends EventTarget implements GattCharacteristic {
  value = new DataView(new ArrayBuffer(20));
  active = 0;
  maxActive = 0;
  failSubscription = false;
  async readValue() {
    return this.value;
  }
  async writeValueWithResponse(_value: ArrayBuffer) {
    this.active++;
    this.maxActive = Math.max(this.active, this.maxActive);
    await Promise.resolve();
    this.active--;
  }
  async startNotifications() {
    if (this.failSubscription) throw new Error("Subscription failed");
    return this;
  }
  emit() {
    this.dispatchEvent(new Event("characteristicvaluechanged"));
  }
}

function fixture() {
  const characteristic = new Characteristic();
  const service: GattService = {
    getCharacteristic: vi.fn(async () => characteristic),
  };
  let server: GattServer;
  const connect = vi.fn(async () => server);
  server = {
    connect,
    disconnect: vi.fn(),
    getPrimaryService: vi.fn(async () => service),
  };
  const device: BleDevice = Object.assign(new EventTarget(), {
    id: "wand-a1b2c3",
    gatt: server,
  });
  const requestDevice = vi.fn(async () => device);
  return {
    characteristic,
    service,
    server,
    connect,
    device,
    requestDevice,
    transport: new BleWandTransport({ requestDevice }),
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function flushOperations(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe("BLE adapter against a fake browser API, not physical BLE", () => {
  it("filters chooser, serializes GATT writes and copies notifications", async () => {
    const f = fixture();
    await f.transport.connect(vi.fn());
    expect(f.requestDevice).toHaveBeenCalledWith({
      filters: [{ services: [WAND_UUIDS.service] }],
    });
    const listener = vi.fn();
    await f.transport.subscribe("motion", listener);
    f.characteristic.emit();
    f.characteristic.value.setUint8(0, 99);
    expect(listener.mock.calls[0][0][0]).toBe(0);
    await Promise.all([
      f.transport.writeControl(new Uint8Array(20)),
      f.transport.writeControl(new Uint8Array(20)),
    ]);
    expect(f.characteristic.maxActive).toBe(1);
    f.transport.disconnect();
  });
  it("detaches old listeners and ignores a callback after disconnect", async () => {
    const f = fixture();
    const lost = vi.fn();
    const oldListener = vi.fn();
    await f.transport.connect(lost);
    await f.transport.subscribe("status", oldListener);
    f.device.dispatchEvent(new Event("gattserverdisconnected"));
    expect(lost).toHaveBeenCalledTimes(1);
    f.characteristic.emit();
    expect(oldListener).not.toHaveBeenCalled();
    await f.transport.connect(vi.fn());
    f.characteristic.emit();
    expect(oldListener).not.toHaveBeenCalled();
    f.transport.disconnect();
  });
  it("surfaces chooser cancellation and subscription failure", async () => {
    const cancelled = new BleWandTransport({
      requestDevice: async () => {
        throw new Error("Chooser cancelled");
      },
    });
    await expect(cancelled.connect(vi.fn())).rejects.toThrow(
      "Chooser cancelled",
    );
    const f = fixture();
    f.characteristic.failSubscription = true;
    await f.transport.connect(vi.fn());
    await expect(f.transport.subscribe("status", vi.fn())).rejects.toThrow(
      "Subscription failed",
    );
    f.transport.disconnect();
  });

  it("rejects a second owner for the same selected device", async () => {
    const f = fixture();
    const sameDevice = Object.assign(new EventTarget(), {
      id: f.device.id,
      gatt: f.server,
    });
    const other = new BleWandTransport({
      requestDevice: vi.fn(async () => sameDevice),
    });
    await f.transport.connect(vi.fn());
    await expect(other.connect(vi.fn())).rejects.toThrow(
      "Selected wand is already in use",
    );

    f.transport.disconnect();
    await other.connect(vi.fn());
    other.disconnect();
  });

  it("does not let delayed cleanup disconnect a newer owner", async () => {
    const f = fixture();
    const firstConnection = deferred<GattServer>();
    f.connect
      .mockImplementationOnce(() => firstConnection.promise)
      .mockResolvedValue(f.server);

    const oldConnection = f.transport.connect(vi.fn());
    const oldResult = expect(oldConnection).rejects.toThrow(
      "Connection superseded",
    );
    await flushOperations();
    expect(f.connect).toHaveBeenCalledTimes(1);
    f.transport.disconnect();

    const sameDevice = Object.assign(new EventTarget(), {
      id: f.device.id,
      gatt: f.server,
    });
    const newer = new BleWandTransport({
      requestDevice: vi.fn(async () => sameDevice),
    });
    await newer.connect(vi.fn());
    firstConnection.resolve(f.server);
    await oldResult;

    expect(f.server.disconnect).toHaveBeenCalledTimes(1);
    await expect(newer.readInfo()).resolves.toHaveLength(20);
    newer.disconnect();
  });

  it("disconnects a late connection when cancellation has no replacement owner", async () => {
    const f = fixture();
    const connection = deferred<GattServer>();
    f.connect.mockImplementationOnce(() => connection.promise);

    const pending = f.transport.connect(vi.fn());
    const result = expect(pending).rejects.toThrow("Connection superseded");
    await flushOperations();
    f.transport.disconnect();
    expect(f.server.disconnect).toHaveBeenCalledTimes(1);

    connection.resolve(f.server);
    await result;
    expect(f.server.disconnect).toHaveBeenCalledTimes(2);
  });

  it("releases ownership when the selected service is missing", async () => {
    const f = fixture();
    vi.mocked(f.server.getPrimaryService).mockRejectedValueOnce(
      new Error("WAND service missing"),
    );
    await expect(f.transport.connect(vi.fn())).rejects.toThrow(
      "WAND service missing",
    );
    expect(f.server.disconnect).toHaveBeenCalledTimes(1);

    const next = new BleWandTransport({ requestDevice: f.requestDevice });
    await next.connect(vi.fn());
    next.disconnect();
  });

  it("rejects pending reads and writes from a disconnected generation", async () => {
    const f = fixture();
    await f.transport.connect(vi.fn());

    const read = deferred<DataView>();
    const readSpy = vi
      .spyOn(f.characteristic, "readValue")
      .mockImplementationOnce(() => read.promise);
    const pendingRead = f.transport.readInfo();
    const readResult = expect(pendingRead).rejects.toThrow(
      "Connection superseded",
    );
    await flushOperations();
    expect(readSpy).toHaveBeenCalledTimes(1);
    f.transport.disconnect();
    read.resolve(new DataView(new ArrayBuffer(20)));
    await readResult;

    await f.transport.connect(vi.fn());
    const write = deferred<void>();
    const writeSpy = vi
      .spyOn(f.characteristic, "writeValueWithResponse")
      .mockImplementationOnce(() => write.promise);
    const pendingWrite = f.transport.writeControl(new Uint8Array(20));
    const writeResult = expect(pendingWrite).rejects.toThrow(
      "Connection superseded",
    );
    await flushOperations();
    expect(writeSpy).toHaveBeenCalledTimes(1);
    f.transport.disconnect();
    write.resolve();
    await writeResult;
  });
});
