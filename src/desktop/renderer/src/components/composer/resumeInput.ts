/** 空草稿使用明确的恢复按钮；输入文字和附件始终交给模型处理。 */
export function isResumeInput(input: string, attachmentCount: number): boolean {
  return attachmentCount === 0 && input.trim() === "";
}
