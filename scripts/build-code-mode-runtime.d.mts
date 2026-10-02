import type { Plugin } from "vite";

export const codeModeRuntimeBanner: string;
export function verifyCodeModeRuntimeInputs(root?: string): Promise<Record<string, unknown>>;
export function buildCodeModeRuntime(root?: string): Promise<Record<string, unknown>>;
export function codeModeRuntimeProvenancePlugin(root?: string): Plugin;
