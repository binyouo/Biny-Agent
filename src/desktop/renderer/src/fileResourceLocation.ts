/** 位置只用于展示，不授予文件访问权限；打开文件仍由主进程校验。 */
export function fileResourceLocation(value: string): string | undefined {
  const normalized = value.replaceAll("\\", "/");
  if (/^(?:\/tmp\/|\/var\/(?:tmp|folders)\/|\/private\/var\/folders\/)|\/AppData\/Local\/Temp\//iu.test(normalized)) return "临时";
  if (/\/(?:\.config|\.biny)\/|\/Library\/Application Support\/|\/AppData\/Roaming\//iu.test(normalized)) return "全局";
  if (!normalized.startsWith("/") && !/^[A-Za-z]:\//u.test(normalized) && !normalized.startsWith("../")) return "项目";
  return undefined;
}
