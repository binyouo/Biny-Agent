/**
 * 出站脱敏策略。
 *
 * 只有开与关：打开后，发给模型厂商的请求里的密钥与个人信息都会换成占位符，回复再换回原值。
 * 原值映射只驻留内存；占位符哈希密钥保存在本机，重启后可从请求原文重建相同占位符。
 */
export interface RedactionSettings {
  enabled: boolean;
}

export const defaultRedactionSettings: RedactionSettings = { enabled: false };

/** 设置里要求脱敏时为真。 */
export function redactionWanted(settings: RedactionSettings | undefined): boolean {
  return settings?.enabled === true;
}
