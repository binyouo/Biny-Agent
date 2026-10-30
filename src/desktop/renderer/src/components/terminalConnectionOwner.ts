import type { DesktopTerminalHandle } from "../../../protocol.js";

/** An explicit tab close drains its connection; ordinary view disposal does not own the PTY. */
export class TerminalConnectionOwner {
  private pending?: Promise<DesktopTerminalHandle>;
  private closing?: Promise<void>;
  private connectionUncertain = false;
  private closed = false;

  private readonly handles: Set<string>;
  constructor(private terminalId: string, private readonly changed: () => void = () => {}) {
    this.handles = new Set([terminalId]);
  }

  owns(terminalId: string): boolean { return this.handles.has(terminalId); }

  /** Only an accepted fresh list may replace an idle attachment owner. */
  refresh(terminalId: string): TerminalConnectionOwner {
    if (this.closing) return this.owns(terminalId) ? this : new TerminalConnectionOwner(terminalId, this.changed);
    if (this.pending) return this;
    return terminalId === this.terminalId && !this.connectionUncertain && !this.closed
      ? this : new TerminalConnectionOwner(terminalId, this.changed);
  }

  connect(operation: () => Promise<DesktopTerminalHandle>, mayCreate = true): Promise<DesktopTerminalHandle> {
    if (this.closed || this.closing) return Promise.reject(new Error("终端标签正在关闭。"));
    if (this.pending) return this.pending;
    this.changed();
    const pending = Promise.resolve().then(operation).then(handle => {
      this.changed();
      this.terminalId = handle.terminalId;
      this.handles.add(handle.terminalId);
      this.connectionUncertain = false;
      return handle;
    }, (error: unknown) => {
      this.changed();
      // IPC rejection need not prove that no terminal was created. Do not claim
      // that disposing an obsolete ID also disposed an unknown replacement.
      this.connectionUncertain ||= mayCreate;
      throw error;
    });
    this.pending = pending;
    void pending.then(() => {
      if (this.pending === pending) this.pending = undefined;
    }, () => {
      if (this.pending === pending) this.pending = undefined;
    });
    return pending;
  }

  close(dispose: (terminalId: string) => Promise<void>): Promise<void> {
    if (this.closed) return Promise.resolve();
    if (this.closing) return this.closing;
    const closing = Promise.resolve().then(async () => {
      if (this.pending) await this.pending;
      if (this.connectionUncertain) throw new Error("无法确认终端连接结果；请重新连接或重新打开终端列表后再关闭。");
      await dispose(this.terminalId);
      this.closed = true;
    });
    this.closing = closing;
    void closing.then(() => {
      if (this.closing === closing) this.closing = undefined;
    }, () => {
      if (this.closing === closing) this.closing = undefined;
    });
    return closing;
  }
}
