import type { DesktopAppearanceSnapshot } from "./protocol.js";

export class AppearancePreviewCoordinator {
  private active?: { owner: number; snapshot: DesktopAppearanceSnapshot };

  constructor(private readonly options: {
    read(): DesktopAppearanceSnapshot;
    publish(snapshot: DesktopAppearanceSnapshot): void;
  }) {}

  snapshot(): DesktopAppearanceSnapshot {
    return structuredClone(this.active?.snapshot ?? this.options.read());
  }

  preview(owner: number, snapshot: DesktopAppearanceSnapshot | null): void {
    if (snapshot === null) {
      this.release(owner);
      return;
    }
    this.active = { owner, snapshot: structuredClone(snapshot) };
    this.options.publish(this.snapshot());
  }

  release(owner: number): void {
    if (this.active?.owner !== owner) return;
    this.active = undefined;
    this.options.publish(this.snapshot());
  }

  committed(): void {
    this.active = undefined;
    this.options.publish(this.snapshot());
  }

  refresh(): void { this.options.publish(this.snapshot()); }
}
