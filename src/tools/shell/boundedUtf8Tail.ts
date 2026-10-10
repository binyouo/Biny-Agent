import { Buffer } from "node:buffer";

/** Bounded UTF-8 tail storage for decoded shell output.
 * Equivalence to appendCappedToLimit requires independently well-formed UTF-16
 * chunks, as supplied by StringDecoder and ASCII diagnostics. For out-of-contract
 * lone surrogates, Buffer.from replaces them per chunk with U+FFFD; it does not
 * preserve them or pair surrogates across chunks as the old helper might.
 * This is deliberately not a replacement contract for public appendCapped.
 */
export class BoundedUtf8Tail {
  static readonly blockBytes = 16 * 1024;
  private readonly blocks: Buffer[] = [];
  private head = 0;
  private length = 0;
  private backingBytes = 0;

  constructor(readonly limitBytes: number) {
    // Match the positive limit contract at runShellCommand's validation boundary.
    if (!Number.isSafeInteger(limitBytes) || limitBytes < 1 || limitBytes > 8 * 1024 * 1024) {
      throw new RangeError("Output tail limit must be an integer in [1, 8 MiB].");
    }
  }

  get retainedBytes(): number { return this.length; }
  get allocatedBlockCount(): number { return this.blocks.length; }
  get allocatedBackingBytes(): number { return this.backingBytes; }

  append(chunk: string): void {
    if (chunk.length === 0) return;
    // Encode only new code units. This temporary Buffer is never retained.
    const input = Buffer.from(chunk, "utf8");
    let offset = Math.max(0, input.length - this.limitBytes);
    const count = input.length - offset;
    if (input.length >= this.limitBytes) {
      this.head = 0;
      this.length = 0;
    } else {
      const discard = Math.max(0, this.length + count - this.limitBytes);
      this.head = (this.head + discard) % this.limitBytes;
      this.length -= discard;
    }
    let position = (this.head + this.length) % this.limitBytes;
    while (offset < input.length) {
      const index = Math.floor(position / BoundedUtf8Tail.blockBytes);
      let block = this.blocks[index];
      if (!block) {
        block = Buffer.allocUnsafeSlow(Math.min(BoundedUtf8Tail.blockBytes, this.limitBytes - index * BoundedUtf8Tail.blockBytes));
        this.blocks[index] = block;
        this.backingBytes += block.buffer.byteLength;
      }
      const inBlock = position % BoundedUtf8Tail.blockBytes;
      const copied = Math.min(block.length - inBlock, input.length - offset);
      input.copy(block, inBlock, offset, offset + copied);
      offset += copied;
      position = (position + copied) % this.limitBytes;
    }
    this.length += count;
    // Trim only at the append boundary, exactly like appendCappedToLimit.
    // At most three continuation bytes of a valid UTF-8 sequence are skipped.
    while (this.length > 0 && (this.at(this.head) & 0xc0) === 0x80) {
      this.head = (this.head + 1) % this.limitBytes;
      this.length -= 1;
    }
  }

  toString(): string {
    if (this.length === 0) return "";
    const result = Buffer.allocUnsafeSlow(this.length);
    let offset = 0;
    let position = this.head;
    while (offset < this.length) {
      const block = this.blocks[Math.floor(position / BoundedUtf8Tail.blockBytes)]!;
      const inBlock = position % BoundedUtf8Tail.blockBytes;
      const count = Math.min(block.length - inBlock, this.length - offset);
      block.copy(result, offset, inBlock, inBlock + count);
      offset += count;
      position = (position + count) % this.limitBytes;
    }
    return result.toString("utf8");
  }

  private at(position: number): number {
    return this.blocks[Math.floor(position / BoundedUtf8Tail.blockBytes)]![position % BoundedUtf8Tail.blockBytes]!;
  }

}
