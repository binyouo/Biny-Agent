/**
 * 新会话欢迎区（hero）。
 *
 * 只在「顶层新建会话」时出现：当前没有选中任何会话、也没有正在进行的对话。
 * 从某个项目文件夹里点 + 新建时不展示，避免在一个已经有明确上下文的项目里
 * 再铺一层欢迎语。
 *
 * 入场动效对齐 Alma 原版：头像/标题/副标题立即淡入（hero-fade）。
 * 建议短语作为 children 注入，跟在副标题下方：biny 的 composer 固定在窗口底部，
 * 短语若挂到 composer 之后会被甩到屏幕最下缘、和 hero 断成两块，所以放在块内。
 */
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
        <AppIcon className="biny-hero-avatar biny-hero-fade" size={88} />
        <h1 className="biny-hero-title biny-hero-fade">今天聊点什么？</h1>
        <p className="biny-hero-subtitle biny-hero-fade">一个想法、半句话、一段粘贴——剩下交给 Biny。</p>
        {children}
      </div>
    </div>
  );
}
