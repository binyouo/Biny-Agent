import { widgetSchema, type WidgetInput } from "./widget.js";

export interface WidgetTheme { dark?: boolean; css?: string }

const morphdomNotice = `The MIT License (MIT)

Copyright (c) Patrick Steele-Idem <pnidem@gmail.com> (psteeleidem.com)

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.`;

const themeCss = `
:root{--background:#fff;--foreground:#252525;--card:#f7f7f7;--primary:#7299a0;--primary-foreground:#fff;--muted:#f1f1f1;--muted-foreground:#666;--border:#ddd;--radius:8px;--chart-1:#7299a0;--chart-2:#899779;--chart-3:#a990ad;--chart-4:#c29173;--chart-5:#bdab6c}
*{box-sizing:border-box}body{margin:0;padding:0;background:transparent;color:var(--foreground);font:14px/1.5 system-ui,sans-serif}#content{display:flow-root;width:100%;overflow-wrap:anywhere}svg,canvas,img{max-width:100%}button,input,select,textarea{font:inherit;color:inherit}button{padding:6px 12px;border:1px solid var(--border);border-radius:var(--radius);background:var(--muted);cursor:pointer}button:hover{background:var(--card)}button.primary{background:var(--primary);color:var(--primary-foreground)}input,select,textarea{border:1px solid var(--border);border-radius:var(--radius);background:var(--background);padding:6px 8px}input[type=range]{padding:0;accent-color:var(--primary)}:focus-visible{outline:2px solid var(--primary);outline-offset:2px}.card{padding:16px;background:var(--card);border:1px solid var(--border);border-radius:calc(var(--radius)*1.5)}@media(prefers-reduced-motion:reduce){*,*::before,*::after{animation:none!important;transition:none!important}}
`;

// 此脚本只在 opaque iframe 内运行，宿主只接收有界的展示与用户动作请求。
const bridge = `
(function(){
const token=__TOKEN__, root=document.getElementById('content');
let scriptsRun=false, lastHtml='', revision=0;
function send(type,data){parent.postMessage(Object.assign({type,token},data),'*')}
function report(){send('widget-resize',{height:Math.max(root.offsetHeight,root.scrollHeight),elementCount:root.querySelectorAll('*').length})}
function setContent(html,complete){
 if(scriptsRun)return;
 if(html!==lastHtml || complete){
  const target=document.createElement('div'); target.id='content'; target.innerHTML=html;
  target.querySelectorAll('iframe,object,embed,base,meta,link').forEach(node=>node.remove());
  target.querySelectorAll('*').forEach(node=>{
   for(const attr of Array.from(node.attributes)){
    if((!complete && /^on/i.test(attr.name)) || /^(?:javascript|file|biny):/i.test(attr.value.trim()))node.removeAttribute(attr.name);
   }
  });
  // innerHTML 不执行脚本；脚本先保持 inert，完成时再显式激活。
  target.querySelectorAll('script').forEach(node=>{node.dataset.widgetType=node.getAttribute('type')||'';node.setAttribute('type','text/widget-inert')});
  morphdom(root,target,{onBeforeElUpdated:(from,to)=>!from.isEqualNode(to)});
  lastHtml=html; report();
 }
 if(complete){
  scriptsRun=true;
  root.querySelectorAll('script').forEach(old=>{
   if(old.hasAttribute('src')){send('widget-error',{message:'不支持远程脚本，请使用内联脚本。'});return}
   const script=document.createElement('script');
   if(old.dataset.widgetType)script.type=old.dataset.widgetType;
   script.textContent=old.textContent;old.replaceWith(script);
  });
  report();
 }
}
window.sendPrompt=text=>{if(typeof text==='string' && text.trim() && text.length<=8000)send('send-prompt',{text:text.trim()})};
window.openLink=url=>{if(typeof url==='string' && /^https?:\\/\\//i.test(url) && url.length<=2048)send('open-link',{url})};
document.addEventListener('click',event=>{const a=event.target.closest&&event.target.closest('a[href]');if(a){event.preventDefault();window.openLink(a.getAttribute('href'))}});
document.addEventListener('submit',event=>event.preventDefault());
window.addEventListener('error',()=>send('widget-error',{message:'可视化脚本执行失败，请重试或检查源码。'}));
window.addEventListener('unhandledrejection',()=>send('widget-error',{message:'可视化脚本执行失败，请重试或检查源码。'}));
window.addEventListener('message',event=>{
 const d=event.data;if(event.source!==parent || !d || d.token!==token)return;
 if(d.type==='set-content' && typeof d.html==='string' && d.html.length<=512000 && Number.isSafeInteger(d.revision) && d.revision>revision){revision=d.revision;setContent(d.html,d.complete===true)}
 if(d.type==='set-theme' && typeof d.css==='string' && d.css.length<=8000){document.getElementById('widget-theme').textContent=d.css;document.documentElement.dataset.theme=d.dark?'dark':'light'}
});
if(typeof ResizeObserver!=='undefined')new ResizeObserver(report).observe(root);
new MutationObserver(report).observe(root,{childList:true,subtree:true,attributes:true,characterData:true});
window.addEventListener('load',report);send('widget-ready',{});
__INITIAL__
})();`;

function scriptText(value: string): string { return value.replace(/<\/script/giu, "<\\/script"); }

export function createWidgetDocument(options: { token: string; morphdomSource: string; theme?: WidgetTheme; widget?: WidgetInput }): string {
  if (!/^[a-zA-Z0-9_-]{1,100}$/u.test(options.token)) throw new Error("Invalid widget token.");
  const widget = options.widget ? widgetSchema.parse(options.widget) : undefined;
  const runtime = bridge.replace("__TOKEN__", JSON.stringify(options.token)).replace("__INITIAL__", () => widget ? `setContent(${JSON.stringify(widget.html)},true);` : "");
  const css = `${themeCss}\n${options.theme?.css ?? ""}`.replace(/<\/style/giu, "<\\/style");
  const title = (widget?.title ?? "可视化").replace(/&/gu, "&amp;").replace(/</gu, "&lt;").replace(/>/gu, "&gt;");
  return `<!doctype html><html data-theme="${options.theme?.dark ? "dark" : "light"}"><head><meta charset="utf-8"><title>${title}</title><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'"><style>${css}</style><style id="widget-theme"></style></head><body><div id="content"></div><script>/* ${morphdomNotice} */\n${scriptText(options.morphdomSource)}</script><script>${scriptText(runtime)}</script></body></html>`;
}

export type WidgetMessage = { type: "widget-ready" } | { type: "widget-resize"; height: number } | { type: "widget-error"; message: string } | { type: "send-prompt"; text: string } | { type: "open-link"; url: string };
export function readWidgetMessage(value: unknown, token: string): WidgetMessage | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const data = value as Record<string, unknown>;
  if (data.token !== token) return undefined;
  if (data.type === "widget-ready") return { type: data.type };
  if (data.type === "widget-resize" && typeof data.height === "number" && Number.isFinite(data.height) && data.height >= 0) return { type: data.type, height: Math.max(50, Math.min(4_000, data.height + 8)) };
  if (data.type === "widget-error" && typeof data.message === "string") return { type: data.type, message: data.message.slice(0, 500) };
  if (data.type === "send-prompt" && typeof data.text === "string" && data.text.trim() && data.text.length <= 8_000) return { type: data.type, text: data.text.trim() };
  if (data.type === "open-link" && typeof data.url === "string" && data.url.length <= 2_048) {
    try { const url = new URL(data.url); if (["http:", "https:"].includes(url.protocol) && !url.username && !url.password) return { type: data.type, url: url.href }; } catch { return undefined; }
  }
  return undefined;
}
