/** 已保存的聊天展示偏好；旧配置沿用原来的展示方式，不修改模型请求。 */
import { createContext, useContext } from "react";
import type { ChatResponseSettings } from "../../../config/schema.js";

export const DEFAULT_CHAT_RESPONSE: Required<ChatResponseSettings> = {
  streaming: true, showTokenUsage: true, markdown: true, singleDollarMath: true,
  collapseThinking: true, openLinksInBrowser: false
};
export const ChatResponseContext = createContext<ChatResponseSettings | undefined>(undefined);
export function useChatResponseSettings(): Required<ChatResponseSettings> {
  const settings = useContext(ChatResponseContext);
  return {
    streaming: settings?.streaming ?? DEFAULT_CHAT_RESPONSE.streaming,
    showTokenUsage: settings?.showTokenUsage ?? DEFAULT_CHAT_RESPONSE.showTokenUsage,
    markdown: settings?.markdown ?? DEFAULT_CHAT_RESPONSE.markdown,
    singleDollarMath: settings?.singleDollarMath ?? DEFAULT_CHAT_RESPONSE.singleDollarMath,
    collapseThinking: settings?.collapseThinking ?? DEFAULT_CHAT_RESPONSE.collapseThinking,
    openLinksInBrowser: settings?.openLinksInBrowser ?? DEFAULT_CHAT_RESPONSE.openLinksInBrowser
  };
}
