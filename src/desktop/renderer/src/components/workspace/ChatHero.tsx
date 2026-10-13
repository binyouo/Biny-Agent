/** 新会话欢迎区；建议短语与输入框保持在同一列，提交时整体淡出。 */
import { AppIcon } from "../AppIcon.js";

interface ChatHeroProps {
  /** 建议短语区，渲染在副标题下方。 */
  children?: React.ReactNode;
  /** 提交后整块淡出，避免和消息流同时出现。 */
  leaving?: boolean;
}

export function ChatHero({ children, leaving = false }: ChatHeroProps): React.JSX.Element {
  return (
    <div className="biny-hero">
      <div className={`biny-hero-inner${leaving ? " is-leaving" : ""}`}>
        <AppIcon className="biny-hero-avatar biny-hero-fade" size={72} />
        <h1 className="biny-hero-title biny-hero-fade">今天聊点什么？</h1>
        <p className="biny-hero-subtitle biny-hero-fade">把下一件事，交给 Biny。</p>
        {children}
      </div>
    </div>
  );
}
