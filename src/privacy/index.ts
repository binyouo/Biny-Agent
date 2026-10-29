/** 出站脱敏：占位符替换、JSON 处理、流式还原、记录与设置。 */
export * from "./settings.js";
export * from "./engine.js";
export * from "./json.js";
export * from "./stream.js";
export * from "./record.js";
export * from "./privacyFetch.js";
export { placeholderTag, placeholderPattern } from "./crypto.js";
export { resetStoreForTest, registeredCount } from "./store.js";
