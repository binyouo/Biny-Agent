import type { z } from "zod";
import type { CodeModeLimits } from "../src/agent/codeMode.js";
import type { ToolExecutionCoordinator } from "../src/agent/toolExecutionCoordinator.js";
import type { defaultConfig } from "../src/config/schema.js";
import type { PermissionManager } from "../src/permission/PermissionManager.js";
import type { SessionRecorder } from "../src/session/recorder.js";
import type { ensureAgentDirs } from "../src/session/store.js";
import type { ToolRegistry } from "../src/tools/registry.js";

export interface CodeModeApprovalGateFixtureInput {
  workspace: string;
  policy: CodeModeLimits;
  idPrefix: string;
  ToolExecutionCoordinator: typeof ToolExecutionCoordinator;
  defaultConfig: typeof defaultConfig;
  PermissionManager: typeof PermissionManager;
  SessionRecorder: typeof SessionRecorder;
  ensureAgentDirs: typeof ensureAgentDirs;
  ToolRegistry: typeof ToolRegistry;
  z: typeof z;
}

export function exerciseCodeModeApprovalGate(input: CodeModeApprovalGateFixtureInput): Promise<void>;
