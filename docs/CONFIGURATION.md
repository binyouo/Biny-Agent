# 模型与配置

Biny 将服务商连接与模型选择分开管理。一个服务商连接可以提供多个模型；会话使用模型别名，别名再指向服务商和实际模型 ID。

## 配置存放在哪里

| 路径 | 用途 |
| --- | --- |
| `~/.config/biny/config.json` | 全局模型、权限和扩展设置。 |
| `<项目>/.biny/settings.json` | 当前项目的模型及部分运行参数覆盖。 |
| `~/.config/biny/models-store.json` | 模型目录缓存。 |
| `~/.biny/agent/` | 按项目分区保存会话和运行状态。 |

`BINY_AGENT_DIR` 会同时重定向全局配置目录和运行数据根目录，适合隔离环境。设置后需在使用同一数据的 Desktop、CLI 和 Host 进程中保持一致。

项目覆盖只接受已支持的运行字段，例如 `defaultModel`、`thinking`、`agent`、`context`、`sandbox`、`checkpoints` 和 `diagnostics`。服务商连接与凭据在全局配置中管理；项目文件中的模型别名必须已存在于全局 `models`。

## 第一次配置

在源码仓库执行：

```bash
pnpm dev -- init
pnpm desktop:dev
```

`init` 创建缺失的全局配置与运行目录，保留已有配置。在 Desktop 的模型设置中添加服务商、填写连接信息并选择模型，然后保存。连接成功与模型请求成功是不同结果；第一次对话还会检查实际凭据和模型请求。

## 使用环境变量提供凭据

以下是需要合入已有全局配置的字段片段，使用仓库默认的 DeepSeek 模型配置作为例子：

```json
{
  "defaultModel": "deepseek-v4-flash",
  "providers": {
    "deepseek": {
      "type": "deepseek",
      "baseUrl": "https://api.deepseek.com",
      "apiKeyEnv": "DEEPSEEK_API_KEY"
    }
  },
  "models": {
    "deepseek-v4-flash": {
      "provider": "deepseek",
      "model": "deepseek-v4-flash"
    }
  }
}
```

把自己的密钥通过本地环境管理方式设置为 `DEEPSEEK_API_KEY`。环境变量必须对发起模型请求的进程可见；从 Dock 打开的 Desktop 不会自动继承另一个终端里临时设置的变量。

这三个名称分别是：

- `deepseek`：服务商配置别名。
- `deepseek-v4-flash`：Biny 选择的模型别名。
- `models.<别名>.model`：发给服务商的模型 ID。

自定义网关应使用它实际支持的 Provider 类型、端点、协议和模型 ID。修改显示名称不会改变请求协议。

## 凭据保存

当前配置保存链路将凭据正文与普通设置分开保存。macOS 命令行使用 Keychain；Desktop 及其独立 Electron Host 使用 Desktop 凭据存储。没有持久凭据存储的平台使用配置声明的环境变量。

同一个配置引用在另一个入口中是否可用，取决于对应凭据存储是否有该值。跨 Desktop 与终端使用时，若提示缺少凭据，检查入口使用的存储或共同可见的环境变量。不要通过提交配置文件、打印令牌或复制会话日志解决凭据问题。

旧配置可能仍有 `apiKey`。这些文件属于敏感本地数据；公开示例使用 `apiKeyEnv`，不放真实密钥。

## 模型切换与辅助请求

运行中保存新的模型或思考设置，后续根回合采用新选择。当前已开始的回合保持准入时的选择；保存成功不表示当前请求已经换了模型。

同一 Desktop 主窗口中的模型与思考选择按选择顺序保存，切换会话不会重置待完成的顺序。切换项目后，已排队的选择仍使用选择时的项目上下文；共享默认模型与项目覆盖的优先级不变。

`toolModel` 用于共享辅助模型选择。显式指定时应填写已配置的模型别名；省略时按可用配置自动选择。压缩、记忆处理和活动分析可能额外发起模型请求，其用量与聊天主请求分别记录。

模型目录中的能力、上下文窗口和价格是元数据。目录刷新失败不证明聊天连接失败，目录存在也不证明账户额度或远端请求可用。

目录刷新遇到 HTTP 错误时显示状态、请求地址和最多 8,192 个字符的诊断前缀。尾部读取失败不会抹掉已取得的诊断，错误响应不会替换上次有效目录。

## 排查

| 现象 | 检查 |
| --- | --- |
| 找不到模型别名 | `defaultModel` 与项目覆盖是否引用全局 `models` 中的键。 |
| 缺少密钥或登录过期 | 当前入口的凭据存储、环境变量和服务商登录状态。 |
| 连接存在但请求失败 | 端点协议、实际模型 ID、服务商额度和返回错误。 |
| 修改后当前回合没变化 | 新选择从后续根回合生效。 |
| 全局选择被项目覆盖 | 当前项目 `.biny/settings.json` 的 `defaultModel`。 |

配置结构以 [schema.ts](../src/config/schema.ts) 和 [项目设置](../src/config/projectSettings.ts) 为准；路径解析见 [paths.ts](../src/config/paths.ts)。权限模式另见 [工具与权限](PERMISSIONS.md)。
