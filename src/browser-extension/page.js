/** 固定页面程序：CSS、开放 Shadow DOM 与语义定位；只在明确操作分支修改页面。 */
export async function pageOperation(operation, args, backendElement) {
  const roots = (root) => {
    const result = [root];
    for (let i = 0; i < result.length && result.length < 200; i++) {
      for (const node of result[i].querySelectorAll("*")) if (node.shadowRoot) result.push(node.shadowRoot);
    }
    return result;
  };
  const name = (node) => (node.getAttribute("aria-label") || node.getAttribute("placeholder") || node.labels?.[0]?.textContent || node.textContent || "").trim();
  const locate = (selector) => {
    if (backendElement) return backendElement.isConnected ? [backendElement] : [];
    if (!selector) return [];
    // 语义定位使用精确名称，避免取第一个近似匹配；CSS 的 >>> 显式跨 Shadow root。
    if (selector.startsWith("text=") || selector.startsWith("role=") || selector.startsWith("testid=")) {
      const all = roots(document).flatMap((root) => [...root.querySelectorAll("*")]);
      if (selector.startsWith("testid=")) return all.filter((node) => node.getAttribute("data-testid") === selector.slice(7));
      if (selector.startsWith("text=")) return all.filter((node) => node.textContent?.trim() === selector.slice(5) && ![...node.children].some((child) => child.textContent?.trim() === selector.slice(5)));
      const [role, ...parts] = selector.slice(5).split("|");
      const implicit = { BUTTON: "button", A: "link", TEXTAREA: "textbox", SELECT: "combobox" };
      return all.filter((node) => (node.getAttribute("role") || implicit[node.tagName] || (node.tagName === "INPUT" ? ({ checkbox: "checkbox", radio: "radio", button: "button", submit: "button" }[node.type] || "textbox") : "")) === role && (!parts.length || name(node) === parts.join("|")));
    }
    let scope = [document];
    const parts = selector.split(/\s*>>>\s*/u);
    for (let i = 0; i < parts.length; i++) {
      const found = scope.flatMap((root) => [...root.querySelectorAll(parts[i])]);
      if (i === parts.length - 1) return found;
      scope = found.map((node) => node.shadowRoot).filter(Boolean);
    }
    return [];
  };
  const visible = (node) => {
    const rect = node.getBoundingClientRect(); const style = getComputedStyle(node);
    return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
  };
  const path = (node) => {
    const root = node.getRootNode();
    const parts = [];
    for (let item = node; item?.nodeType === 1; item = item.parentElement) {
      if (item.id && root.querySelectorAll(`#${CSS.escape(item.id)}`).length === 1) { parts.unshift(`#${CSS.escape(item.id)}`); break; }
      const siblings = [...(item.parentNode?.children || [])].filter((child) => child.tagName === item.tagName);
      parts.unshift(item.tagName.toLowerCase() + (siblings.length > 1 ? `:nth-of-type(${siblings.indexOf(item) + 1})` : ""));
    }
    return (root.host ? `${path(root.host)} >>> ` : "") + parts.join(" > ");
  };
  if (operation === "read") {
    const scopes = roots(document);
    return { url: location.href, title: document.title.slice(0, 4096),
      text: scopes.map((root) => root === document ? document.body?.innerText || "" : root.textContent || "").join("\n").slice(0, args.maxCharacters ?? 24000),
      interactive: scopes.flatMap((root) => [...root.querySelectorAll('a,button,input,textarea,select,[role="button"],[role="link"],[contenteditable="true"]')]).filter(visible).slice(0, 200).map((node) => ({ tag: node.tagName.toLowerCase(), name: name(node).slice(0, 120), selector: path(node) })) };
  }
  if (operation === "wait") {
    const deadline = Date.now() + (args.timeoutMs ?? 5000);
    let previous;
    do {
      let ready = false;
      if (args.state === "load") ready = document.readyState === "complete";
      else if (args.state === "domcontentloaded") ready = document.readyState !== "loading";
      else {
        const nodes = locate(args.selector);
        if (nodes.length > 1) throw new Error("匹配到多个元素，请使用更精确的定位。");
        const node = nodes[0];
        if (args.state === "hidden") ready = !node || !visible(node);
        else if (args.state === "attached") ready = Boolean(node);
        else if (node && visible(node) && !node.matches(':disabled,[aria-disabled="true"]')) {
          const rect = node.getBoundingClientRect();
          const box = [rect.x, rect.y, rect.width, rect.height].join(",");
          ready = previous === box; previous = box;
        }
      }
      if (ready) return true;
      if (Date.now() >= deadline) throw new Error("等待页面或元素就绪超时。");
      await new Promise((resolve) => setTimeout(resolve, 80));
    } while (Date.now() <= deadline);
    throw new Error("等待页面或元素就绪超时。");
  }
  if (operation === "download") {
    const url = new URL(args.url);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error("下载地址无效。");
    const response = await fetch(url, { credentials: "include", signal: AbortSignal.timeout(args.timeoutMs ?? 8000) });
    if (!response.ok || !response.body) throw new Error(`下载失败：HTTP ${response.status}`);
    const reader = response.body.getReader(); const chunks = []; let size = 0;
    try {
      while (true) {
        const { value, done } = await reader.read(); if (done) break;
        size += value.length; if (size > 8 * 1024 * 1024) throw new Error("下载超过 8 MiB 限制。"); chunks.push(value);
      }
    } finally { await reader.cancel(); reader.releaseLock(); }
    let binary = "";
    for (const chunk of chunks) for (let i = 0; i < chunk.length; i += 8192) binary += String.fromCharCode(...chunk.subarray(i, i + 8192));
    return { mimeType: (response.headers.get("content-type") || "application/octet-stream").split(";")[0].slice(0, 120), data: btoa(binary) };
  }
  if (operation === "scroll" && !args.selector) return { x: innerWidth / 2, y: innerHeight / 2, viewportWidth: innerWidth, viewportHeight: innerHeight };
  const matches = locate(args.selector);
  if (matches.length !== 1) throw new Error("需要唯一元素，请重新读取页面。");
  const element = matches[0];
  if (!(element instanceof HTMLElement) || element.matches(':disabled,[aria-disabled="true"]')) throw new Error("元素不可操作。");
  if (operation === "reveal") { element.scrollIntoView({ block: "center", inline: "center", behavior: "instant" }); return true; }
  if (operation === "upload") {
    if (!(element instanceof HTMLInputElement) || element.type !== "file" || (!element.multiple && args.files.length > 1)) throw new Error("目标不是兼容的文件上传控件。");
    const transfer = new DataTransfer();
    for (const file of args.files) {
      const bytes = Uint8Array.from(atob(file.data), (value) => value.charCodeAt(0));
      transfer.items.add(new File([bytes], file.name, { type: file.mimeType }));
    }
    element.files = transfer.files;
    element.dispatchEvent(new Event("input", { bubbles: true })); element.dispatchEvent(new Event("change", { bubbles: true }));
    return { count: transfer.files.length };
  }
  if (!visible(element)) throw new Error("元素不可见。");
  const rect = element.getBoundingClientRect();
  const point = { x: Math.max(0, rect.x) + Math.min(rect.width, innerWidth - Math.max(0, rect.x)) / 2, y: Math.max(0, rect.y) + Math.min(rect.height, innerHeight - Math.max(0, rect.y)) / 2 };
  for (let candidate = element; candidate;) {
    const root = candidate.getRootNode();
    const hit = root.elementFromPoint(point.x, point.y);
    if (!hit || (hit !== candidate && !candidate.contains(hit))) throw new Error("元素被遮挡。");
    candidate = root.host;
  }
  if (operation === "fill" || operation === "press") element.focus();
  if (operation === "fill") {
    if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
      if (element.readOnly || (element instanceof HTMLInputElement && !["text", "search", "url", "tel", "password", "email", "number"].includes(element.type))) throw new Error("元素不可编辑。");
      element.select();
    } else if (element.isContentEditable) { const range = document.createRange(); range.selectNodeContents(element); const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range); }
    else throw new Error("元素不可编辑。");
  }
  return { ...point, viewportWidth: innerWidth, viewportHeight: innerHeight };
}
