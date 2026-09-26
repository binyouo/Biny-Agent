/**
 * preload 桥。
 *
 * 把 `DesktopApi` 里声明的每个方法转成一次 IPC 调用，通过 contextBridge 暴露成
 * `window.biny`。这里只做转发，不放任何业务逻辑——渲染进程能做什么完全由 `protocol.ts`
 * 的接口和主进程的 handler 决定。
 *
 * 事件订阅返回取消函数，组件卸载时必须调用，否则监听器会随重新挂载不断累积。
 */
import { contextBridge, ipcRenderer, webUtils } from "electron";
import { createDesktopReadRequest } from "../../readRequests.js";
import type { ActivityRuntimeSnapshot } from "../../../activity/types.js";
import type { DesktopAgentEventEnvelope, DesktopApi, DesktopBrowserSnapshot, DesktopMenuAction, DesktopQuickChatScreenContext, DesktopSessionHandoff, DesktopSettingsCloseRequest, DesktopTerminalEvent } from "../../protocol.js";
import { desktopIpc } from "../../protocol.js";

const pendingReferenceOpens: Array<{ uri: string; projectId: string }> = [];
let referenceOpenListener: ((target: { uri: string; projectId: string }) => void) | undefined;
ipcRenderer.on(desktopIpc.referenceOpen, (_event, target: { uri: string; projectId: string }) => {
  if (referenceOpenListener) referenceOpenListener(target);
  else pendingReferenceOpens.push(target);
});

const readRequest = createDesktopReadRequest((channel, ...args) => ipcRenderer.invoke(channel, ...args));

const api: DesktopApi = {
  activitySuggestions: async () => await ipcRenderer.invoke(desktopIpc.activitySuggestions),
  crystalRequest: async (request) => await ipcRenderer.invoke(desktopIpc.crystalRequest, request),
  bootstrap: async () => await readRequest(desktopIpc.bootstrap),
  openProject: async () => await ipcRenderer.invoke(desktopIpc.openProject),
  createEmptyProject: async () => await ipcRenderer.invoke(desktopIpc.createEmptyProject),
  selectProject: async (projectId) => await ipcRenderer.invoke(desktopIpc.selectProject, projectId),
  commitSelection: async (projectId, sessionId, activeView) => await ipcRenderer.invoke(desktopIpc.commitSelection, projectId, sessionId, activeView),
  setActiveView: async (activeView) => await ipcRenderer.invoke(desktopIpc.setActiveView, activeView),
  setProjectPinned: async (projectId, pinned) => await ipcRenderer.invoke(desktopIpc.setProjectPinned, projectId, pinned),
  reorderProjects: async (projectIds) => await ipcRenderer.invoke(desktopIpc.reorderProjects, projectIds),
  renameProject: async (projectId, name) => await ipcRenderer.invoke(desktopIpc.renameProject, projectId, name),
  removeProject: async (projectId) => await ipcRenderer.invoke(desktopIpc.removeProject, projectId),
  refreshProject: async (projectId) => await ipcRenderer.invoke(desktopIpc.refreshProject, projectId),
  projectGitStatus: async (projectId) => await readRequest(desktopIpc.projectGitStatus, projectId),
  initializeProjectGit: async (projectId) => await ipcRenderer.invoke(desktopIpc.initializeProjectGit, projectId),
  commitProjectFiles: async (projectId, input) => await ipcRenderer.invoke(desktopIpc.commitProjectFiles, projectId, input),
  projectGitRemote: async (projectId, action) => await ipcRenderer.invoke(desktopIpc.projectGitRemote, projectId, action),
  listProjectBranches: async (projectId) => await readRequest(desktopIpc.listProjectBranches, projectId),
  switchProjectBranch: async (projectId, branchName) => await ipcRenderer.invoke(desktopIpc.switchProjectBranch, projectId, branchName),
  createProjectBranch: async (projectId, branchName) => await ipcRenderer.invoke(desktopIpc.createProjectBranch, projectId, branchName),
  revealProject: async (projectId) => await ipcRenderer.invoke(desktopIpc.revealProject, projectId),
  openProjectTerminal: async (projectId) => await ipcRenderer.invoke(desktopIpc.openProjectTerminal, projectId),
  startDraft: async (projectId) => await ipcRenderer.invoke(desktopIpc.startDraft, projectId),
  readSessionTrace: async (projectId, sessionId) => await readRequest(desktopIpc.readSessionTrace, projectId, sessionId),
  openSession: async (projectId, sessionId) => await ipcRenderer.invoke(desktopIpc.openSession, projectId, sessionId),
  listSessionTreePage: async (projectId, options) => await ipcRenderer.invoke(desktopIpc.listSessionTreePage, projectId, options),
  renameSession: async (projectId, sessionId, title, expectedRevision) => await ipcRenderer.invoke(desktopIpc.renameSession, projectId, sessionId, title, expectedRevision),
  pinSession: async (projectId, sessionId, pinned, expectedRevision) => await ipcRenderer.invoke(desktopIpc.pinSession, projectId, sessionId, pinned, expectedRevision),
  archiveSession: async (projectId, sessionId, archived, expectedRevision) => await ipcRenderer.invoke(desktopIpc.archiveSession, projectId, sessionId, archived, expectedRevision),
  markSessionRead: async (projectId, sessionId, expectedRevision) => await ipcRenderer.invoke(desktopIpc.markSessionRead, projectId, sessionId, expectedRevision),
  duplicateSession: async (projectId, sessionId) => await ipcRenderer.invoke(desktopIpc.duplicateSession, projectId, sessionId),
  deleteSession: async (projectId, sessionId) => await ipcRenderer.invoke(desktopIpc.deleteSession, projectId, sessionId),
  exportSession: async (projectId, sessionId, format) => await ipcRenderer.invoke(desktopIpc.exportSession, projectId, sessionId, format),
  importSession: async (projectId) => await ipcRenderer.invoke(desktopIpc.importSession, projectId),
  sendPrompt: async (projectId, sessionId, input, attachments, delivery, personalization, idempotencyKey, promptContext, capabilitySelection, draftPlanning, draftIncognito) => await ipcRenderer.invoke(
    desktopIpc.sendPrompt,
    projectId,
    sessionId,
    input,
    attachments,
    delivery,
    personalization,
    idempotencyKey,
    promptContext,
    capabilitySelection,
    draftPlanning,
    draftIncognito
  ),
  mutateQueuedMessage: async (projectId, sessionId, action, mutation) => await ipcRenderer.invoke(
    desktopIpc.mutateQueuedMessage,
    projectId,
    sessionId,
    action,
    mutation
  ),
  toolCatalog: async (projectId) => await readRequest(desktopIpc.toolCatalog, projectId),
  resumeInterruptedTurn: async (projectId, sessionId) => await ipcRenderer.invoke(desktopIpc.resumeInterruptedTurn, projectId, sessionId),
  editPrompt: async (projectId, sessionId, userMessageIndex, input, attachments, idempotencyKey) => await ipcRenderer.invoke(desktopIpc.editPrompt, projectId, sessionId, userMessageIndex, input, attachments, idempotencyKey),
  retryPrompt: async (projectId, sessionId, targetMessageId, input, attachments, idempotencyKey) => await ipcRenderer.invoke(desktopIpc.retryPrompt, projectId, sessionId, targetMessageId, input, attachments, idempotencyKey),
  switchMessageVersion: async (projectId, sessionId, messageId, direction) => await ipcRenderer.invoke(desktopIpc.switchMessageVersion, projectId, sessionId, messageId, direction),
  cancelRun: async (projectId, runId) => await ipcRenderer.invoke(desktopIpc.cancelRun, projectId, runId),
  runSlashCommand: async (projectId, sessionId, command) => await ipcRenderer.invoke(desktopIpc.runSlashCommand, projectId, sessionId, command),
  runInspectorCommand: async (projectId, owner, kind, input, history) => await ipcRenderer.invoke(desktopIpc.runInspectorCommand, projectId, owner, kind, input, history),
  resolvePermission: async (projectId, requestId, result) => await ipcRenderer.invoke(desktopIpc.resolvePermission, projectId, requestId, result),
  setPermissionMode: async (projectId, mode) => await ipcRenderer.invoke(desktopIpc.setPermissionMode, projectId, mode),
  switchModel: async (projectId, alias, thinking) => await ipcRenderer.invoke(desktopIpc.switchModel, projectId, alias, thinking),
  testModelConfiguration: async (projectId, configuration) => await ipcRenderer.invoke(desktopIpc.testModelConfiguration, projectId, configuration),
  readModelApiKey: async (projectId, providerAlias) => await ipcRenderer.invoke(desktopIpc.readModelApiKey, projectId, providerAlias),
  fetchModelCatalog: async (projectId, providerAlias, force) => await ipcRenderer.invoke(desktopIpc.fetchModelCatalog, projectId, providerAlias, force),
  startModelLogin: async (projectId, provider) => await ipcRenderer.invoke(desktopIpc.startModelLogin, projectId, provider),
  cancelModelLogin: async (projectId, provider, authRequestId) => await ipcRenderer.invoke(desktopIpc.cancelModelLogin, projectId, provider, authRequestId),
  compact: async (projectId, hint) => await ipcRenderer.invoke(desktopIpc.compact, projectId, hint),
  runtimeProjection: async (projectId) => await ipcRenderer.invoke(desktopIpc.runtimeProjection, projectId),
  planProjection: async (projectId, sessionId) => await ipcRenderer.invoke(desktopIpc.planProjection, projectId, sessionId),
  runtimeMutation: async (projectId, operation, payload) => await ipcRenderer.invoke(desktopIpc.runtimeMutation, projectId, operation, payload),
  runtimeEvents: async (projectId, afterSequence, limit) => await ipcRenderer.invoke(desktopIpc.runtimeEvents, projectId, afterSequence, limit),
  startProjectPreview: async (projectId, entry) => await ipcRenderer.invoke(desktopIpc.startProjectPreview, projectId, entry),
  projectPreviewAvailability: async (projectId) => await readRequest(desktopIpc.projectPreviewAvailability, projectId),
  projectPreviewStatus: async (projectId) => await readRequest(desktopIpc.projectPreviewStatus, projectId),
  stopProjectPreview: async (projectId) => await ipcRenderer.invoke(desktopIpc.stopProjectPreview, projectId),
  browserSnapshot: async (projectId) => await ipcRenderer.invoke(desktopIpc.browserSnapshot, projectId),
  browserInspect: async (projectId, tabId, enabled) => await ipcRenderer.invoke(desktopIpc.browserInspect, projectId, tabId, enabled),
  browserCapture: async (projectId, tabId, selection) => await ipcRenderer.invoke(desktopIpc.browserCapture, projectId, tabId, selection),
  browserRelayStatus: async () => await ipcRenderer.invoke(desktopIpc.browserRelayStatus),
  browserRelaySetup: async () => await ipcRenderer.invoke(desktopIpc.browserRelaySetup),
  browserRelayDisconnect: async () => await ipcRenderer.invoke(desktopIpc.browserRelayDisconnect),
  browserAction: async (projectId, action) => await ipcRenderer.invoke(desktopIpc.browserAction, projectId, action),
  browserBounds: async (projectId, tabId, bounds) => await ipcRenderer.invoke(desktopIpc.browserBounds, projectId, tabId, bounds),
  onBrowserOpenRequest(listener) {
    const handler = (_event: Electron.IpcRendererEvent, projectId: string): void => listener(projectId);
    ipcRenderer.on(desktopIpc.browserOpenRequest, handler);
    return () => ipcRenderer.removeListener(desktopIpc.browserOpenRequest, handler);
  },
  onBrowserState(listener) {
    const handler = (_event: Electron.IpcRendererEvent, snapshot: DesktopBrowserSnapshot): void => listener(snapshot);
    ipcRenderer.on(desktopIpc.browserState, handler);
    return () => ipcRenderer.removeListener(desktopIpc.browserState, handler);
  },
  openBrowser: async (url, purpose) => await ipcRenderer.invoke(desktopIpc.openBrowser, url, purpose),
  cookieJarStatus: async () => await ipcRenderer.invoke(desktopIpc.cookieJarStatus),
  exportCookies: async () => await ipcRenderer.invoke(desktopIpc.exportCookies),
  importCookies: async () => await ipcRenderer.invoke(desktopIpc.importCookies),
  listBrowserProfiles: async () => await readRequest(desktopIpc.listBrowserProfiles),
  importBrowserProfile: async (profileId) => await ipcRenderer.invoke(desktopIpc.importBrowserProfile, profileId),
  clearCookies: async () => await ipcRenderer.invoke(desktopIpc.clearCookies),
  personalizationOverview: async (projectId, sessionId) => await ipcRenderer.invoke(desktopIpc.personalizationOverview, projectId, sessionId),
  saveChatPersonalization: async (projectId, sessionId, input, expectedRevision) => await ipcRenderer.invoke(desktopIpc.saveChatPersonalization, projectId, sessionId, input, expectedRevision),
  saveSessionIncognito: async (projectId, sessionId, isIncognito, expectedRevision) => await ipcRenderer.invoke(desktopIpc.saveSessionIncognito, projectId, sessionId, isIncognito, expectedRevision),
  memoryOverview: async (projectId) => await ipcRenderer.invoke(desktopIpc.memoryOverview, projectId),
  memoryStats: async (projectId) => await ipcRenderer.invoke(desktopIpc.memoryStats, projectId),
  memoryEntries: async (projectId, offset, limit, includeArchived) => await ipcRenderer.invoke(desktopIpc.memoryEntries, projectId, offset, limit, includeArchived),
  temporalClues: async (query) => await readRequest(desktopIpc.temporalClues, query),
  temporalIgnoreClue: async (id) => await ipcRenderer.invoke(desktopIpc.temporalIgnoreClue, id),
  temporalMarkSeen: async (ids, day, timeZone) => await ipcRenderer.invoke(desktopIpc.temporalMarkSeen, ids, day, timeZone),
  temporalMarkTodaySeen: async (day, timeZone) => await ipcRenderer.invoke(desktopIpc.temporalMarkTodaySeen, day, timeZone),
  referenceKinds: async () => await ipcRenderer.invoke(desktopIpc.referenceKinds),
  referenceSearch: async (projectId, query, kind, timeZone) => await ipcRenderer.invoke(desktopIpc.referenceSearch, projectId, query, kind, timeZone),
  referenceResolve: async (projectId, uri) => await ipcRenderer.invoke(desktopIpc.referenceResolve, projectId, uri),
  referenceBacklinks: async (projectId, uri) => await ipcRenderer.invoke(desktopIpc.referenceBacklinks, projectId, uri),
  referenceCaptureSnippet: async (projectId, sourceUri, start, end) => await ipcRenderer.invoke(desktopIpc.referenceCaptureSnippet, projectId, sourceUri, start, end),
  referenceCaptureQuote: async (projectId, sourceUri, quote) => await ipcRenderer.invoke(desktopIpc.referenceCaptureQuote, projectId, sourceUri, quote),
  referenceForMessage: async (projectId, threadId, messageId) => await ipcRenderer.invoke(desktopIpc.referenceForMessage, projectId, threadId, messageId),
  referenceDateDetail: async (projectId, uri) => await ipcRenderer.invoke(desktopIpc.referenceDateDetail, projectId, uri),
  referenceDateCalendar: async (projectId, uri) => await ipcRenderer.invoke(desktopIpc.referenceDateCalendar, projectId, uri),
  referenceIndexOriginal: async (projectId, sessionId, requestId) => await ipcRenderer.invoke(desktopIpc.referenceIndexOriginal, projectId, sessionId, requestId),
  referenceCancelIndex: async (requestId) => await ipcRenderer.invoke(desktopIpc.referenceCancelIndex, requestId),
  saveMemorySettings: async (projectId, input) => await ipcRenderer.invoke(desktopIpc.saveMemorySettings, projectId, input),
  identityOverview: async (projectId) => await ipcRenderer.invoke(desktopIpc.identityOverview, projectId),
  saveIdentityDocument: async (projectId, document, content, expectedRevision, reason) => await ipcRenderer.invoke(
    desktopIpc.saveIdentityDocument,
    projectId,
    document,
    content,
    expectedRevision,
    reason
  ),
  settingsSnapshot: async (projectId, sessionId) => await ipcRenderer.invoke(desktopIpc.settingsSnapshot, projectId, sessionId),
  saveSettings: async (projectId, input) => await ipcRenderer.invoke(desktopIpc.saveSettings, projectId, input),
  activitySnapshot: async () => await ipcRenderer.invoke(desktopIpc.activitySnapshot),
  activityPermissions: async () => await ipcRenderer.invoke(desktopIpc.activityPermissions),
  activitySettings: async () => await ipcRenderer.invoke(desktopIpc.activitySettings),
  updateActivitySettings: async (patch, expectedConfigRevision) => await ipcRenderer.invoke(desktopIpc.activityUpdateSettings, patch, expectedConfigRevision),
  requestActivityPermission: async (pane) => await ipcRenderer.invoke(desktopIpc.activityRequestPermission, pane),
  searchActivity: async (query, limit) => await ipcRenderer.invoke(desktopIpc.activitySearch, query, limit),
  activitySessionDetail: async (sessionId) => await ipcRenderer.invoke(desktopIpc.activitySessionDetail, sessionId),
  activitySnapshotPreview: async (snapshotId) => await ipcRenderer.invoke(desktopIpc.activitySnapshotPreview, snapshotId),
  activityReport: async (date) => await ipcRenderer.invoke(desktopIpc.activityReport, date),
  threadBriefRequest: async (request) => await ipcRenderer.invoke(desktopIpc.threadBriefRequest, request),
  onThreadBriefChanged: (listener) => {
    const handle = (): void => listener();
    ipcRenderer.on(desktopIpc.threadBriefChanged, handle);
    return () => { ipcRenderer.removeListener(desktopIpc.threadBriefChanged, handle); };
  },
  dailyMemoryNote: async (date) => await ipcRenderer.invoke(desktopIpc.dailyMemoryNote, date),
  clearActivity: async () => await ipcRenderer.invoke(desktopIpc.activityClear),
  stageSettingsCredential: async (secret, scope) => await ipcRenderer.invoke(desktopIpc.stageSettingsCredential, secret, scope),
  completeModelLoginForSettings: async (projectId, provider, authRequestId, pastedAuthorization) => await ipcRenderer.invoke(
    desktopIpc.completeModelLoginForSettings,
    projectId,
    provider,
    authRequestId,
    pastedAuthorization
  ),
  releaseSettingsCredentials: async (handles) => await ipcRenderer.invoke(desktopIpc.releaseSettingsCredentials, handles),
  updateSettingsDraftState: async (state) => await ipcRenderer.invoke(desktopIpc.settingsDraftState, state),
  respondSettingsCloseRequest: async (requestId, response) => await ipcRenderer.invoke(
    desktopIpc.settingsCloseResponse,
    requestId,
    response
  ),
  searchMemory: async (projectId, query) => await ipcRenderer.invoke(desktopIpc.searchMemory, projectId, query),
  addMemoryEntry: async (projectId, input) => await ipcRenderer.invoke(desktopIpc.addMemoryEntry, projectId, input),
  updateMemoryEntry: async (projectId, entryId, patch) => await ipcRenderer.invoke(desktopIpc.updateMemoryEntry, projectId, entryId, patch),
  deleteMemoryEntry: async (projectId, entryId) => await ipcRenderer.invoke(desktopIpc.deleteMemoryEntry, projectId, entryId),
  archiveMemoryEntry: async (projectId, entryId, archived) => await ipcRenderer.invoke(desktopIpc.archiveMemoryEntry, projectId, entryId, archived),
  archivedMemoryEntries: async (projectId, offset, limit, includeChains) => await ipcRenderer.invoke(desktopIpc.archivedMemoryEntries, projectId, offset, limit, includeChains),
  runMemorySleep: async (projectId) => await ipcRenderer.invoke(desktopIpc.runMemorySleep, projectId),
  memorySleepStatus: async (projectId) => await ipcRenderer.invoke(desktopIpc.memorySleepStatus, projectId),
  memorySleepRuns: async (projectId) => await ipcRenderer.invoke(desktopIpc.memorySleepRuns, projectId),
  previewMemorySleep: async (projectId) => await ipcRenderer.invoke(desktopIpc.previewMemorySleep, projectId),
  cancelMemorySleep: async (projectId) => await ipcRenderer.invoke(desktopIpc.cancelMemorySleep, projectId),
  clearMemory: async (projectId) => await ipcRenderer.invoke(desktopIpc.clearMemory, projectId),
  memoryEmbeddingStatus: async (projectId) => await ipcRenderer.invoke(desktopIpc.memoryEmbeddingStatus, projectId),
  downloadMemoryEmbeddingModel: async (projectId, model) => await ipcRenderer.invoke(desktopIpc.downloadMemoryEmbeddingModel, projectId, model),
  cancelMemoryEmbeddingDownload: async (projectId, model) => await ipcRenderer.invoke(desktopIpc.cancelMemoryEmbeddingDownload, projectId, model),
  deleteMemoryEmbeddingModel: async (projectId, model) => await ipcRenderer.invoke(desktopIpc.deleteMemoryEmbeddingModel, projectId, model),
  rebuildMemoryEmbeddingIndex: async (projectId) => await ipcRenderer.invoke(desktopIpc.rebuildMemoryEmbeddingIndex, projectId),
  cancelMemoryEmbeddingRebuild: async (projectId) => await ipcRenderer.invoke(desktopIpc.cancelMemoryEmbeddingRebuild, projectId),
  saveAttachment: async (projectId, name, mimeType, bytes) => await ipcRenderer.invoke(desktopIpc.saveAttachment, projectId, name, mimeType, bytes),
  // 渲染进程拿不到拖入文件的真实路径，只有 preload 里的 webUtils 能解析。
  resolveDroppedFile: (file) => webUtils.getPathForFile(file),
  listWorkspaceDirectory: async (projectId, relativePath) => await ipcRenderer.invoke(desktopIpc.listWorkspaceDirectory, projectId, relativePath),
  readWorkspaceFile: async (projectId, relativePath) => await ipcRenderer.invoke(desktopIpc.readWorkspaceFile, projectId, relativePath),
  readInlineImage: async (projectId, relativePath) => await ipcRenderer.invoke(desktopIpc.readInlineImage, projectId, relativePath),
  openWorkspaceFile: async (projectId, relativePath) => await ipcRenderer.invoke(desktopIpc.openWorkspaceFile, projectId, relativePath),
  recipeSuggestions: async (projectId, sessionId) => await ipcRenderer.invoke(desktopIpc.recipeSuggestions, projectId, sessionId),
  setRecipeState: async (projectId, sessionId, recipeId, state) => await ipcRenderer.invoke(desktopIpc.recipeState, projectId, sessionId, recipeId, state),
  skillCatalog: async (projectId) => await readRequest(desktopIpc.skillCatalog, projectId),
  skillSettings: async (projectId) => await readRequest(desktopIpc.skillSettings, projectId),
  importSkillSource: async () => await ipcRenderer.invoke(desktopIpc.skillSourceImport),
  installSkillSource: async (sourceId) => await ipcRenderer.invoke(desktopIpc.skillSourceInstall, sourceId),
  importExistingSkills: async (skillIds) => await ipcRenderer.invoke(desktopIpc.skillImportExisting, skillIds),
  skillDiscovery: async () => await ipcRenderer.invoke(desktopIpc.skillDiscoverySnapshot),
  searchSkills: async (query, limit, offset) => await ipcRenderer.invoke(desktopIpc.skillDiscoverySearch, query, limit, offset),
  installDiscoveredSkill: async (skill) => await ipcRenderer.invoke(desktopIpc.skillDiscoveryInstall, skill),
  addSkillRepository: async (repository) => await ipcRenderer.invoke(desktopIpc.skillRepositoryAdd, repository),
  removeSkillRepository: async (owner, name) => await ipcRenderer.invoke(desktopIpc.skillRepositoryRemove, owner, name),
  readSkillFile: async (skillId, relativePath) => await ipcRenderer.invoke(desktopIpc.skillFileRead, skillId, relativePath),
  checkSkill: async (skillId) => await ipcRenderer.invoke(desktopIpc.skillCheck, skillId),
  skillVersion: async (skillId) => await ipcRenderer.invoke(desktopIpc.skillVersion, skillId),
  updateSkillVersion: async (skillId, expectedVersion) => await ipcRenderer.invoke(desktopIpc.skillVersionUpdate, skillId, expectedVersion),
  rollbackSkillVersion: async (skillId, expectedVersion) => await ipcRenderer.invoke(desktopIpc.skillVersionRollback, skillId, expectedVersion),
  writeSkillFile: async (skillId, relativePath, content) => await ipcRenderer.invoke(desktopIpc.skillFileWrite, skillId, relativePath, content),
  openSkillDirectory: async (skillId) => await ipcRenderer.invoke(desktopIpc.skillOpenDirectory, skillId),
  pluginRegistry: async (projectId) => await ipcRenderer.invoke(desktopIpc.pluginRegistry, projectId),
  refreshPluginRegistry: async (projectId) => await ipcRenderer.invoke(desktopIpc.pluginRegistryRefresh, projectId),
  installPlugin: async (projectId, pluginId, scope) => await ipcRenderer.invoke(desktopIpc.pluginInstall, projectId, pluginId, scope),
  setPluginEnabled: async (projectId, pluginId, enabled, scope) => await ipcRenderer.invoke(desktopIpc.pluginSetEnabled, projectId, pluginId, enabled, scope),
  uninstallPlugin: async (projectId, pluginId, scope) => await ipcRenderer.invoke(desktopIpc.pluginUninstall, projectId, pluginId, scope),
  openPluginDirectory: async (projectId, scope) => await ipcRenderer.invoke(desktopIpc.pluginOpenDirectory, projectId, scope),
  mcpSnapshot: async (projectId) => await ipcRenderer.invoke(desktopIpc.mcpSnapshot, projectId),
  mcpCatalog: async () => await ipcRenderer.invoke(desktopIpc.mcpCatalog),
  mcpRefreshCatalog: async () => await ipcRenderer.invoke(desktopIpc.mcpRefreshCatalog),
  mcpUpsertServer: async (projectId, originalName, draft, expectedConfigRevision) => await ipcRenderer.invoke(
    desktopIpc.mcpUpsertServer,
    projectId,
    originalName,
    draft,
    expectedConfigRevision
  ),
  mcpSetEnabled: async (projectId, name, enabled, expectedConfigRevision) => await ipcRenderer.invoke(
    desktopIpc.mcpSetEnabled,
    projectId,
    name,
    enabled,
    expectedConfigRevision
  ),
  mcpDeleteServer: async (projectId, name, expectedConfigRevision) => await ipcRenderer.invoke(
    desktopIpc.mcpDeleteServer,
    projectId,
    name,
    expectedConfigRevision
  ),
  mcpTestServer: async (projectId, draft) => await ipcRenderer.invoke(desktopIpc.mcpTestServer, projectId, draft),
  mcpReconnect: async (projectId, name) => await ipcRenderer.invoke(desktopIpc.mcpReconnect, projectId, name),
  mcpDetails: async (projectId, name) => await ipcRenderer.invoke(desktopIpc.mcpDetails, projectId, name),
  mcpLoginStart: async (projectId, name) => await ipcRenderer.invoke(desktopIpc.mcpLoginStart, projectId, name),
  mcpLoginFinish: async (projectId, name, id) => await ipcRenderer.invoke(desktopIpc.mcpLoginFinish, projectId, name, id),
  mcpLoginCancel: async (id) => await ipcRenderer.invoke(desktopIpc.mcpLoginCancel, id),
  mcpLogout: async (projectId, name) => await ipcRenderer.invoke(desktopIpc.mcpLogout, projectId, name),
  openExternal: async (url) => await ipcRenderer.invoke(desktopIpc.openExternal, url),
  openSystemSettings: async (pane) => await ipcRenderer.invoke(desktopIpc.openSystemSettings, pane),
  setSidebarWidth: async (width) => await ipcRenderer.invoke(desktopIpc.setSidebarWidth, width),
  setFilePanelWidth: async (width) => await ipcRenderer.invoke(desktopIpc.setFilePanelWidth, width),
  setThemePreference: async (theme) => await ipcRenderer.invoke(desktopIpc.setThemePreference, theme),
  setFontPreference: async (font) => await ipcRenderer.invoke(desktopIpc.setFontPreference, font),
  toggleQuickChat: async () => await ipcRenderer.invoke(desktopIpc.quickChatToggle),
  hideQuickChat: async () => await ipcRenderer.invoke(desktopIpc.quickChatHide),
  closeQuickChat: async () => await ipcRenderer.invoke(desktopIpc.quickChatClose),
  quickChatSettings: async () => await ipcRenderer.invoke(desktopIpc.quickChatSettings),
  setQuickChatSettings: async (settings) => await ipcRenderer.invoke(desktopIpc.setQuickChatSettings, settings),
  quickChatScreenContext: async () => await ipcRenderer.invoke(desktopIpc.quickChatScreenContext),
  recaptureQuickChatContext: async () => await ipcRenderer.invoke(desktopIpc.quickChatRecaptureContext),
  traverseQuickChatApp: async (pid) => await ipcRenderer.invoke(desktopIpc.quickChatTraverseApp, pid),
  getQuickChatClickThrough: async () => await ipcRenderer.invoke(desktopIpc.quickChatGetClickThrough),
  setQuickChatClickThrough: async (enabled) => await ipcRenderer.invoke(desktopIpc.quickChatSetClickThrough, enabled),
  createTerminal: async (projectId, cols, rows, slotId) => await ipcRenderer.invoke(desktopIpc.createTerminal, projectId, cols, rows, slotId),
  listTerminals: async (projectId) => await ipcRenderer.invoke(desktopIpc.listTerminals, projectId),
  // 输入与尺寸是高频小消息，用 send 避免 invoke 的往返开销。
  writeTerminal: (terminalId, data) => { ipcRenderer.send(desktopIpc.writeTerminal, terminalId, data); },
  resizeTerminal: (terminalId, cols, rows) => { ipcRenderer.send(desktopIpc.resizeTerminal, terminalId, cols, rows); },
  disposeTerminal: async (terminalId) => await ipcRenderer.invoke(desktopIpc.disposeTerminal, terminalId),
  onTerminalEvent(listener) {
    const handler = (_event: Electron.IpcRendererEvent, event: DesktopTerminalEvent): void => listener(event);
    ipcRenderer.on(desktopIpc.terminalEvent, handler);
    return () => ipcRenderer.removeListener(desktopIpc.terminalEvent, handler);
  },
  onAgentEvent(listener) {
    const handler = (_event: Electron.IpcRendererEvent, envelope: DesktopAgentEventEnvelope): void => listener(envelope);
    ipcRenderer.on(desktopIpc.event, handler);
    return () => ipcRenderer.removeListener(desktopIpc.event, handler);
  },
  onQuickChatContext(listener: (context: DesktopQuickChatScreenContext) => void) {
    const handler = (_event: Electron.IpcRendererEvent, context: DesktopQuickChatScreenContext): void => listener(context);
    ipcRenderer.on(desktopIpc.quickChatContext, handler);
    return () => ipcRenderer.removeListener(desktopIpc.quickChatContext, handler);
  },
  onQuickChatFocusInput(listener: () => void) {
    const handler = (_event: Electron.IpcRendererEvent): void => listener();
    ipcRenderer.on(desktopIpc.quickChatFocusInput, handler);
    return () => ipcRenderer.removeListener(desktopIpc.quickChatFocusInput, handler);
  },
  onQuickChatClickThroughChanged(listener: (enabled: boolean) => void) {
    const handler = (_event: Electron.IpcRendererEvent, enabled: boolean): void => listener(enabled);
    ipcRenderer.on(desktopIpc.quickChatClickThroughChanged, handler);
    return () => ipcRenderer.removeListener(desktopIpc.quickChatClickThroughChanged, handler);
  },
  onSessionHandoff(listener) {
    const handler = (_event: Electron.IpcRendererEvent, target: DesktopSessionHandoff): void => listener(target);
    ipcRenderer.on(desktopIpc.sessionHandoff, handler);
    return () => ipcRenderer.removeListener(desktopIpc.sessionHandoff, handler);
  },
  onReferenceOpen(listener) {
    referenceOpenListener = listener;
    for (const target of pendingReferenceOpens.splice(0)) listener(target);
    return () => { if (referenceOpenListener === listener) referenceOpenListener = undefined; };
  },
  onMenuAction(listener) {
    const handler = (_event: Electron.IpcRendererEvent, action: DesktopMenuAction): void => listener(action);
    ipcRenderer.on(desktopIpc.menuAction, handler);
    return () => ipcRenderer.removeListener(desktopIpc.menuAction, handler);
  },
  onSettingsCloseRequest(listener) {
    const handler = (_event: Electron.IpcRendererEvent, request: DesktopSettingsCloseRequest): void => listener(request);
    ipcRenderer.on(desktopIpc.settingsCloseRequest, handler);
    return () => ipcRenderer.removeListener(desktopIpc.settingsCloseRequest, handler);
  },
  onActivityEvent(listener) {
    const handler = (_event: Electron.IpcRendererEvent, snapshot: ActivityRuntimeSnapshot): void => listener(snapshot);
    ipcRenderer.on(desktopIpc.activityEvent, handler);
    return () => ipcRenderer.removeListener(desktopIpc.activityEvent, handler);
  }
};

contextBridge.exposeInMainWorld("biny", api);
