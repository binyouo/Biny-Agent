/** 新会话欢迎区；建议短语与输入框保持在同一列，提交时整体淡出。 */
import { AppIcon } from "../AppIcon.js";

interface ChatHeroProps {
  ref?: React.Ref<HTMLDivElement>;
  /** 建议短语区，渲染在副标题下方。 */
  children?: React.ReactNode;
  /** 提交后保留到淡出完成，期间退出键盘与指针交互。 */
  leaving?: boolean;
}

export function ChatHero({ children, leaving = false, ref }: ChatHeroProps): React.JSX.Element {
  return (
    <div ref={ref} className={`biny-hero${leaving ? " is-leaving" : ""}`} aria-hidden={leaving || undefined} inert={leaving}>
      <div className="biny-hero-inner">
        <AppIcon animated hidden={leaving} className="biny-hero-avatar" size={64} />
        <h1 className="biny-hero-title biny-hero-fade">今天聊点什么？</h1>
        <p className="biny-hero-subtitle biny-hero-fade">把下一件事，交给 Biny。</p>
        {children}
      </div>
    </div>
  );
}
