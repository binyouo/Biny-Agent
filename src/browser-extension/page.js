/** 固定页面程序：CSS、开放 Shadow DOM 与语义定位；只在明确操作分支修改页面。 */
export async function pageOperation(operation, args, backendElement) {
  const roots = (root) => {
    const result = [root];
    if (root.shadowRoot) result.push(root.shadowRoot);
    for (let i = 0; i < result.length && result.length < 200; i++) {
      for (const node of result[i].querySelectorAll("*")) if (node.shadowRoot) result.push(node.shadowRoot);
    }
    return result;
  };
  const normalizeText = (value) => String(value || "").replace(/\s+/gu, " ").trim();
  const name = (node) => {
    const ariaLabel = node.getAttribute("aria-label");
    if (ariaLabel) return normalizeText(ariaLabel);
    const labelledBy = node.getAttribute("aria-labelledby");
    if (labelledBy) {
      const labels = labelledBy.split(/\s+/u).map(id => node.getRootNode().getElementById?.(id) || document.getElementById(id)).filter(Boolean);
      if (labels.length) return normalizeText(labels.map(label => label.textContent).join(" "));
    }
    if (node.labels?.length) return normalizeText([...node.labels].map(label => label.textContent).join(" "));
    if (node instanceof HTMLImageElement) return normalizeText(node.alt || node.title);
    if (node instanceof HTMLInputElement && ["button", "submit", "reset"].includes(node.type)) return normalizeText(node.value || node.title);
    return normalizeText(node.getAttribute("placeholder") || node.getAttribute("title") || node.innerText || node.textContent);
  };
  const role = (node) => {
    const explicit = node.getAttribute("role")?.trim().split(/\s+/u)[0];
    if (explicit) return explicit;
    const implicit = { BUTTON: "button", A: "link", TEXTAREA: "textbox", SELECT: node.multiple ? "listbox" : "combobox", IMG: node.alt === "" ? "presentation" : "img", OPTION: "option", SUMMARY: "button", NAV: "navigation", MAIN: "main", ASIDE: "complementary", FORM: "form", UL: "list", OL: "list", LI: "listitem", TABLE: "table", TR: "row", TD: "cell", TH: node.scope === "row" ? "rowheader" : "columnheader", PROGRESS: "progressbar", METER: "meter" };
    if (implicit[node.tagName]) return implicit[node.tagName];
    if (node instanceof HTMLInputElement) return ({ checkbox: "checkbox", radio: "radio", button: "button", submit: "button", reset: "button", search: "searchbox" }[node.type] || "textbox");
    if (/^H[1-6]$/u.test(node.tagName)) return "heading";
    return "";
  };
  const descendants = (scopes) => {
    const all = scopes.flatMap(root => roots(root).flatMap(scope => Array.from(scope.querySelectorAll("*"))));
    return [...new Set(all)];
  };
  const matchesText = (candidate, requested, exact) => exact ? normalizeText(candidate) === normalizeText(requested) : normalizeText(candidate).includes(normalizeText(requested));
  const queryWithin = (scopes, selector) => {
    if (!selector) return [];
    if (["text=", "role=", "testid=", "label=", "placeholder="].some(prefix => selector.startsWith(prefix))) {
      const all = descendants(scopes);
      if (selector.startsWith("testid=")) return all.filter(node => node.getAttribute("data-testid") === selector.slice(7));
      if (selector.startsWith("text=")) return all.filter(node => normalizeText(node.textContent) === normalizeText(selector.slice(5)) && ![...node.children].some(child => normalizeText(child.textContent) === normalizeText(selector.slice(5))));
      if (selector.startsWith("placeholder=")) return all.filter(node => node.getAttribute("placeholder") === selector.slice(12));
      if (selector.startsWith("label=")) return all.filter(node => node.getAttribute("aria-label") === selector.slice(6) || [...(node.labels || [])].some(label => normalizeText(label.textContent) === normalizeText(selector.slice(6))));
      const [requestedRole, ...parts] = selector.slice(5).split("|");
      const requestedName = parts.join("|");
      return all.filter(node => role(node) === requestedRole && (!parts.length || name(node) === normalizeText(requestedName)));
    }
    let current = scopes;
    const parts = selector.split(/\s*>>>\s*/u);
    for (let i = 0; i < parts.length; i++) {
      const found = current.flatMap(root => [...root.querySelectorAll(parts[i])]);
      if (i === parts.length - 1) return [...new Set(found)];
      current = found.map(node => node.shadowRoot).filter(Boolean);
    }
    return [];
  };
  const locateChain = (steps) => {
    let matches = [document];
    for (const step of steps) {
      if (step.m === "locator") matches = queryWithin(matches, step.selector);
      else if (step.m === "getByRole") matches = descendants(matches).filter(node => role(node) === step.role && (step.name === undefined || matchesText(name(node), step.name, step.exact === true)));
      else if (step.m === "getByText") matches = descendants(matches).filter(node => matchesText(node.innerText || node.textContent, step.text, step.exact === true));
      else if (step.m === "getByLabel") matches = descendants(matches).filter(node => node.matches("input:not([type=hidden]),textarea,select,button,meter,output,progress,[contenteditable=true],[role=textbox],[role=combobox],[role=checkbox],[role=radio],[role=searchbox]") && (name(node) === normalizeText(step.label) || [...(node.labels || [])].some(label => matchesText(label.textContent, step.label, true))));
      else if (step.m === "getByPlaceholder") matches = descendants(matches).filter(node => matchesText(node.getAttribute("placeholder"), step.placeholder, step.exact === true));
      else if (step.m === "getByTestId") matches = descendants(matches).filter(node => node.getAttribute("data-testid") === step.testId);
      else if (step.m === "first") matches = matches.slice(0, 1);
      else if (step.m === "last") matches = matches.slice(-1);
      else if (step.m === "nth") matches = matches[step.index] ? [matches[step.index]] : [];
      else if (step.m === "filter") matches = matches.filter(node => matchesText(node.innerText || node.textContent, step.hasText, false));
      else if (step.m === "visible") matches = matches.filter(visible);
      if (matches.length > 10_000) throw new Error("定位结果过多，请缩小查询范围。");
    }
    return matches;
  };
  const locate = (selector) => {
    if (backendElement) return backendElement.isConnected ? [backendElement] : [];
    return queryWithin([document], selector);
  };
  const visible = (node) => {
    const rect = node.getBoundingClientRect(); const style = getComputedStyle(node);
    return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
  };
  const interactiveSelector = 'a,button,input,textarea,select,[role],[contenteditable="true"],[tabindex],[onclick]';
  const domBox = (node) => {
    const rect = node.getBoundingClientRect();
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
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
      interactive: scopes.flatMap((root) => [...root.querySelectorAll('a,button,input,textarea,select,[role="button"],[role="link"],[contenteditable="true"]')]).filter(visible).slice(0, 200).map((node) => ({ tag: node.tagName.toLowerCase(), role: role(node) || undefined, name: name(node).slice(0, 120), selector: path(node) })) };
  }
  if (operation === "dom_snapshot") {
    const scopes = roots(document);
    const elements = [...new Set(scopes.flatMap(root => [...root.querySelectorAll(interactiveSelector)]))]
      .filter(node => {
        if (!visible(node)) return false;
        const rect = node.getBoundingClientRect();
        return rect.bottom > 0 && rect.right > 0 && rect.top < innerHeight && rect.left < innerWidth;
      })
      .slice(0, 200)
      .map(node => ({ tag: node.tagName.toLowerCase(), role: role(node) || undefined, name: name(node).slice(0, 120), selector: path(node), box: domBox(node) }));
    return { url: location.href, title: document.title.slice(0, 4096), elements };
  }
  if (operation === "dom_target") {
    const matches = locate(args.selector);
    if (matches.length !== 1) throw new Error("DOM 引用已失效，请重新获取页面快照。");
    const element = matches[0];
    const expected = args.expected || {};
    const box = domBox(element);
    const expectedBox = expected.box || {};
    const sameBox = ["x", "y", "width", "height"].every(key => Number.isFinite(expectedBox[key]) && Math.abs(box[key] - expectedBox[key]) <= 2);
    if (!(element instanceof HTMLElement) || element.matches(':disabled,[aria-disabled="true"]') || !visible(element)
      || element.tagName.toLowerCase() !== expected.tag || (role(element) || undefined) !== expected.role || name(element).slice(0, 120) !== expected.name || !sameBox) {
      throw new Error("DOM 引用已失效，请重新获取页面快照。");
    }
    return { selector: path(element) };
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
  if (operation === "locator_read") {
    const action = args.action;
    const deadline = Date.now() + (action.m === "waitFor" ? action.timeoutMs ?? 5000 : 0);
    do {
      const matches = locateChain(args.steps);
      if (action.m === "count") return matches.length;
      if (action.m === "waitFor") {
        const state = action.state ?? "visible";
        if (matches.length > 1 && state !== "detached") throw new Error("需要唯一匹配，请使用 first、last 或 nth 定位。");
        const ready = state === "attached" ? matches.length === 1
          : state === "detached" ? matches.length === 0
            : state === "hidden" ? matches.length === 0 || !visible(matches[0])
              : matches.length === 1 && visible(matches[0]);
        if (ready) return true;
        if (Date.now() >= deadline) throw new Error("等待定位器状态超时。");
        await new Promise(resolve => setTimeout(resolve, 80));
        continue;
      }
      if (["isVisible", "isEnabled"].includes(action.m) && matches.length === 0) return false;
      if (matches.length !== 1) throw new Error("需要唯一匹配，请使用 first、last、nth 或 count。");
      const element = matches[0];
      if (action.m === "isVisible") return visible(element);
      if (action.m === "isEnabled") return !element.matches(':disabled,[aria-disabled="true"]');
      if (action.m === "textContent") return (element.textContent || "").slice(0, 20_000);
      if (action.m === "innerText") return (element.innerText || element.textContent || "").slice(0, 20_000);
      if (action.m === "getAttribute") return element.getAttribute(action.name)?.slice(0, 8_000) ?? null;
      if (action.m === "boundingBox") {
        if (!visible(element)) return null;
        const rect = element.getBoundingClientRect();
        return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
      }
      throw new Error("不支持的定位器读取操作。");
    } while (Date.now() <= deadline);
    throw new Error("等待定位器状态超时。");
  }
  if (operation === "locator_target") {
    const matches = locateChain(args.steps);
    if (matches.length !== 1) throw new Error("需要唯一匹配，请使用 first、last 或 nth 定位。");
    const element = matches[0];
    if (!(element instanceof HTMLElement) || element.matches(':disabled,[aria-disabled="true"]') || !visible(element)) throw new Error("目标元素不可操作。");
    const selector = path(element);
    if (selector.length > 2_000) throw new Error("定位路径过长，请改用更短的 CSS selector。");
    return { selector };
  }
  if (operation === "media_source") {
    const matches = locate(args.selector);
    if (matches.length !== 1) throw new Error("需要唯一媒体元素，请重新读取页面。");
    const element = matches[0];
    const supported = (node) => node instanceof HTMLImageElement || node instanceof HTMLMediaElement || node instanceof HTMLSourceElement || node instanceof HTMLAnchorElement;
    const nested = supported(element) ? [] : [...(element.querySelectorAll?.("img,video,audio") || [])];
    if (nested.length === 0 && !supported(element)) nested.push(...(element.querySelectorAll?.("source,a[href]") || []));
    if (nested.length > 1) throw new Error("目标包含多个媒体元素，请使用更精确的 selector。");
    const target = nested[0] || element;
    let source;
    if (supported(target)) source = target.currentSrc || target.src || target.href || target.getAttribute("data-src");
    else source = target.getAttribute("data-src");
    if (!source) throw new Error("目标不是图片、音视频、媒体 source 或链接元素，或尚无可下载地址。");
    const url = new URL(source, location.href);
    if (url.username || url.password) throw new Error("媒体地址不能包含账号或密码。");
    if (["http:", "https:"].includes(url.protocol)) return { url: url.href };
    if (url.protocol !== "blob:") throw new Error("仅支持 HTTP(S) 或当前页面创建的 blob 媒体。");
    const response = await fetch(url.href, { credentials: "include", signal: AbortSignal.timeout(15_000) });
    if (!response.ok || !response.body) throw new Error(`媒体下载失败：HTTP ${response.status}`);
    const reader = response.body.getReader(); const chunks = []; let size = 0;
    try {
      while (true) {
        const { value, done } = await reader.read(); if (done) break;
        size += value.length; if (size > 8 * 1024 * 1024) throw new Error("媒体文件超过 8 MiB 限制。"); chunks.push(value);
      }
    } finally { await reader.cancel(); reader.releaseLock(); }
    let binary = "";
    for (const chunk of chunks) for (let i = 0; i < chunk.length; i += 8192) binary += String.fromCharCode(...chunk.subarray(i, i + 8192));
    return { data: btoa(binary), mimeType: (response.headers.get("content-type") || "application/octet-stream").split(";")[0].slice(0, 120) };
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
  if (operation === "scroll") {
    window.scrollBy(args.x ?? 0, args.y ?? 0);
    return { x: scrollX, y: scrollY };
  }
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
  if (operation === "select_option") {
    if (!(element instanceof HTMLSelectElement)) throw new Error("目标不是下拉选择控件。");
    const values = args.values;
    if (!Array.isArray(values) || values.length === 0 || (!element.multiple && values.length > 1)) throw new Error("下拉选项值无效。");
    const options = [...element.options];
    if (values.some((value) => typeof value !== "string" || !options.some((option) => option.value === value))) throw new Error("找不到指定下拉选项。");
  }
  if (operation === "set_checked") {
    if (!(element instanceof HTMLInputElement) || !["checkbox", "radio"].includes(element.type)) throw new Error("目标不是复选框或单选框。");
    if (element.type === "radio" && args.checked === false && element.checked) throw new Error("单选框不能取消选中。");
  }
  const rect = element.getBoundingClientRect();
  const point = { x: Math.max(0, rect.x) + Math.min(rect.width, innerWidth - Math.max(0, rect.x)) / 2, y: Math.max(0, rect.y) + Math.min(rect.height, innerHeight - Math.max(0, rect.y)) / 2 };
  for (let candidate = element; candidate;) {
    const root = candidate.getRootNode();
    const hit = root.elementFromPoint(point.x, point.y);
    if (!hit || (hit !== candidate && !candidate.contains(hit))) throw new Error("元素被遮挡。");
    candidate = root.host;
  }
  if (operation === "select_option") {
    for (const option of element.options) option.selected = args.values.includes(option.value);
    element.dispatchEvent(new Event("input", { bubbles: true })); element.dispatchEvent(new Event("change", { bubbles: true }));
    return { values: [...element.selectedOptions].map((option) => option.value) };
  }
  if (operation === "set_checked") {
    if (element.checked !== args.checked) element.click();
    return { checked: element.checked };
  }
  if (operation === "type") {
    if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
      if (element.readOnly || (element instanceof HTMLInputElement && !["text", "search", "url", "tel", "password", "email", "number"].includes(element.type))) throw new Error("元素不可编辑。");
    } else if (!element.isContentEditable) throw new Error("元素不可编辑。");
    element.focus();
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
