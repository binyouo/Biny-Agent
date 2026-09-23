/** 恢复入口只识别明确的继续指令；补充要求和附件仍作为正常消息发送。 */
export function isResumeInput(input: string, attachmentCount: number): boolean {
  return attachmentCount === 0 && /^(?:继续(?:上次的?任务|任务)?[。！!]?|\/continue)?$/u.test(input.trim());
}
