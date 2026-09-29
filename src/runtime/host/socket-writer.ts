import { encodeHostFrame, runtimeHostMaxFrameBytes, type HostFrame } from "./protocol.js";

export const runtimeHostMaxBufferedSocketBytes = runtimeHostMaxFrameBytes * 2;

export interface HostWritableSocket {
  readonly destroyed: boolean;
  readonly writableLength: number;
  write(data: string): boolean;
  destroy(): unknown;
  on(event: "drain" | "close", listener: () => void): unknown;
  off(event: "drain" | "close", listener: () => void): unknown;
}

interface PendingFrame {
  data: string;
  bytes: number;
}

export class BoundedHostSocketWriter {
  private readonly queue: PendingFrame[] = [];
  private queuedBytes = 0;
  private waitingForDrain = false;
  private disposed = false;

  constructor(
    private readonly socket: HostWritableSocket,
    private readonly maxBufferedBytes = runtimeHostMaxBufferedSocketBytes
  ) {
    if (!Number.isSafeInteger(maxBufferedBytes) || maxBufferedBytes <= 0) {
      throw new Error("maxBufferedBytes must be a positive safe integer.");
    }
    socket.on("drain", this.onDrain);
    socket.on("close", this.dispose);
  }

  send(frame: HostFrame): boolean {
    if (this.disposed || this.socket.destroyed) return false;
    const data = encodeHostFrame(frame);
    const bytes = Buffer.byteLength(data);
    if (bytes > runtimeHostMaxFrameBytes || this.socket.writableLength + this.queuedBytes + bytes > this.maxBufferedBytes) {
      this.dispose();
      this.socket.destroy();
      return false;
    }
    if (this.waitingForDrain || this.queue.length > 0) {
      this.queue.push({ data, bytes });
      this.queuedBytes += bytes;
      return true;
    }
    if (!this.socket.write(data)) this.waitingForDrain = true;
    return true;
  }

  dispose = (): void => {
    if (this.disposed) return;
    this.disposed = true;
    this.queue.length = 0;
    this.queuedBytes = 0;
    this.socket.off("drain", this.onDrain);
    this.socket.off("close", this.dispose);
  };

  private readonly onDrain = (): void => {
    this.waitingForDrain = false;
    while (!this.disposed && !this.socket.destroyed && this.queue.length > 0) {
      const next = this.queue.shift();
      if (!next) return;
      this.queuedBytes -= next.bytes;
      if (!this.socket.write(next.data)) {
        this.waitingForDrain = true;
        return;
      }
    }
  };
}
