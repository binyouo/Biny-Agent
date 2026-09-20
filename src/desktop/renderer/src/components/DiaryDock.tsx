/** 按本地日期阅读已有日记；读取不会触发日结或模型请求。 */
import { useEffect, useState } from "react";
import { Dialog, DialogHeader } from "@astryxdesign/core/Dialog";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Icon } from "./Icon.js";
import "../styles/diary.css";

const plugins = [remarkGfm];

function localDate(offset = 0): string {
  const date = new Date();
  date.setDate(date.getDate() + offset);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

export function DiaryDock(): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const [date, setDate] = useState(localDate);
  const [reload, setReload] = useState(0);
  const [source, setSource] = useState(false);
  const [result, setResult] = useState<{ date: string; content?: string; error?: string }>();

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setResult(undefined);
    void window.biny.dailyMemoryNote(date).then((note) => {
      if (!cancelled) setResult({ date, content: note.content });
    }).catch((cause: unknown) => {
      if (!cancelled) setResult({ date, error: cause instanceof Error ? cause.message : "日记读取失败" });
    });
    // 快速切换日期、关闭后重开时，旧请求不得覆盖当前正文。
    return () => { cancelled = true; };
  }, [open, date, reload]);

  const current = result?.date === date ? result : undefined;
  const content = current?.content?.replace(/<!--[\s\S]*?-->/gu, "").trim();
  return <>
    <button aria-label="日记" aria-haspopup="dialog" className="biny-chrome-button" title="日记" type="button" onClick={() => { setDate(localDate()); setOpen(true); }}>
      <Icon name="file-pen" size={16} />
    </button>
    <Dialog isOpen={open} onOpenChange={setOpen} padding={0} width={840} purpose="form">
      <div className="diary-window">
        <div className="diary-title"><DialogHeader onOpenChange={setOpen} title="日记" /></div>
        <div className="diary-toolbar">
          <div className="diary-dates" aria-label="日记日期">
            <button aria-pressed={date === localDate()} onClick={() => setDate(localDate())} type="button">今天</button>
            <button aria-pressed={date === localDate(-1)} onClick={() => setDate(localDate(-1))} type="button">昨天</button>
            <input aria-label="选择日记日期" type="date" max={localDate()} value={date} onChange={(event) => { if (event.target.value) setDate(event.target.value); }} />
          </div>
          <div className="diary-actions">
            <button aria-pressed={source} onClick={() => setSource(!source)} type="button">{source ? "预览" : "Markdown"}</button>
            <button aria-label="重新读取日记" title="重新读取日记" onClick={() => setReload((value) => value + 1)} type="button"><Icon name="refresh" size={15} /></button>
          </div>
        </div>
        <section className="diary-body" aria-label={`${date} 日记`} aria-busy={!current}>
          {!current ? <p className="diary-message" role="status">正在读取日记…</p>
            : current.error ? <div className="diary-message" role="alert"><p>{current.error}</p><button onClick={() => setReload((value) => value + 1)} type="button">重试</button></div>
            : !content ? <div className="diary-message"><Icon name="file-pen" size={28} /><h3>这一天还没有日记</h3><p>聊天完成后会留下摘要，每日总结会在日结后出现。</p></div>
            : source ? <pre className="diary-source">{content}</pre>
            : <article className="markdown-body"><Markdown remarkPlugins={plugins} skipHtml components={{
              // 日记属于全局资料，不把相对路径交给当前工作区，也不自动加载远程图片。
              img: ({ alt }) => <span>{alt ? `[图片：${alt}]` : "[图片]"}</span>,
              a: ({ href, children }) => <a href={href && /^(https?:\/\/|#)/iu.test(href) ? href : undefined} onClick={(event) => {
                if (!href || !/^https?:\/\//iu.test(href)) return;
                event.preventDefault();
                void window.biny.openExternal(href).catch((cause: unknown) => setResult({ date, content: current.content, error: cause instanceof Error ? cause.message : "链接打开失败" }));
              }}>{children}</a>
            }}>{content}</Markdown></article>}
        </section>
        <footer className="diary-footer">{date} · 聊天摘要与每日回顾</footer>
      </div>
    </Dialog>
  </>;
}
