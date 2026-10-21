/**
 * 桌面端全局配置存储。
 *
 * 生产环境直接复用 CLI 的全局配置路径；凭据用 `DesktopSafeStorageCredentialStore`
 * （Electron safeStorage 加密落自管文件），不走 `security` CLI，避免 ACL 授权卡死。
 * 测试通过标准 CredentialStore 注入内存实现。
 */
import type { CredentialStore } from "../../../config/credentials.js";
import { FileConfigStore } from "../../../config/store.js";
import { DesktopSafeStorageCredentialStore } from "./DesktopSafeStorageCredentialStore.js";

export class DesktopConfigStore extends FileConfigStore {
  override readonly supportsDetachedRuntimeHost: boolean;

  constructor(root: string, credentials: CredentialStore = new DesktopSafeStorageCredentialStore(root)) {
    super(root, { globalDir: root, credentialStore: credentials });
    // 只有 safeStorage 可由独立 Electron Host 重建；注入的测试后端不作此承诺。
    this.supportsDetachedRuntimeHost = credentials instanceof DesktopSafeStorageCredentialStore;
  }
}
