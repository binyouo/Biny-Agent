/** 配对地址只保存在扩展本地，不回传到普通状态或页面。 */
const name = document.querySelector("#name");
const url = document.querySelector("#url");
const status = document.querySelector("#status");
const saved = await chrome.storage.local.get(["browserName", "pairingUrl"]);
name.value = saved.browserName || "Chrome";
url.value = saved.pairingUrl || "";
document.querySelector("#settings").addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    const address = new URL(url.value.trim());
    if (address.protocol !== "ws:" || address.hostname !== "127.0.0.1" || address.pathname !== "/relay" || !/^[a-f0-9]{64}$/.test(address.searchParams.get("token") || "")) throw new Error("请粘贴 Biny 提供的完整配对地址。");
    await chrome.storage.local.set({ pairingUrl: address.href, browserName: name.value.trim() || "Chrome" });
    await chrome.runtime.sendMessage({ type: "reconnect" });
    status.textContent = "正在连接…";
  } catch (error) { status.textContent = error.message; }
});
document.querySelector("#disconnect").addEventListener("click", async () => {
  await chrome.storage.local.remove("pairingUrl"); url.value = ""; await chrome.runtime.sendMessage({ type: "reconnect" });
});
async function refresh() { try { status.textContent = (await chrome.runtime.sendMessage({ type: "status" })).status; } catch { status.textContent = "扩展暂不可用，请重新加载扩展。"; } }
await refresh();
setInterval(() => void refresh(), 2000);
