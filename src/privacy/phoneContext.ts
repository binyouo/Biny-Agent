const phoneWords = new Set(["phone", "phones", "mobile", "mobiles", "tel", "telephone", "cell", "cellphone", "contact", "contacts", "whatsapp", "sms", "msisdn", "fax"]);
const credentialLabel = /password|passwd|secret|token|credential|api[_-]?key|access[_-]?key|private[_-]?key|密码|密碼|密钥|金鑰|パスワード/iu;

function fieldWords(name: string): string[] {
  return name.replace(/([A-Z]+)([A-Z][a-z])/gu, "$1 $2").replace(/([a-z0-9])([A-Z])/gu, "$1 $2").toLowerCase().split(/[^a-z0-9]+/u);
}

function phoneField(name: string): boolean {
  return /手机|电话|電話|联系|聯繫|联络/u.test(name) || fieldWords(name).some(word => phoneWords.has(word));
}

function fieldAllows(name: string, known: boolean): boolean {
  if (phoneField(name)) return true;
  const words = fieldWords(name);
  if (["id", "ids", "uid", "hash", "digest", "checksum", "cursor"].includes(words.at(-1) ?? "")) return false;
  if (credentialLabel.test(name) || name.toLowerCase() === "number") return true;
  // 已确认的号码在通用 value 字段中仍应保护，明确业务编号和计数字段除外。
  return known && !/订单|编号|单号|工单|序号|流水号|交易号/u.test(name)
    && !words.some(word => ["order", "ticket", "invoice", "count", "amount", "numbers", "timestamp"].includes(word));
}

/** 同形数字先按字段或邻近标签判断；较长标识中的片段不能作为手机号。 */
export function phoneContextAllows(text: string, start: number, end: number, field?: string, known = false): boolean {
  if (/[A-Za-z0-9]/u.test(`${text[start - 1] ?? ""}${text[end] ?? ""}`)) return false;
  if (end - start > 11) return true;
  if (field && !text.slice(0, start).trim() && !text.slice(end).trim()) return fieldAllows(field, known);

  const before = text.slice(Math.max(0, start - 128), start);
  const xml = /<([\p{L}\p{N}_.:-]+)([ \t]+[^<>]*)?>[ \t"']*$/u.exec(before);
  if (xml) return !/\btype[ \t]*=[ \t]*["']?(?:id|uid|number)["']?(?:[ \t]|$)/iu.test(xml[2] ?? "") && fieldAllows(xml[1]!, known);
  const assignment = /([\p{L}\p{N}_.-]+)(?:[ \t]+(no\.?|number))?["']?[ \t]*[:=：][ \t]*["']?[ \t]*$/iu.exec(before);
  // 显式凭据即使只含数字，也不能因字段不是电话而失去已有保护。
  if (assignment) return fieldAllows(assignment[1]!, known);

  const label = before.trimEnd().replace(/[是为為][ \t]*$/u, "").trimEnd();
  if (label.endsWith("#")) return false;
  if (/(?:订单(?:编号|号)?|单号|编号|流水号|工单号?|运单号|快递单号|交易号|序号|账单号|id号)$/iu.test(label)) return false;
  const idLabel = /(?:^|[^A-Za-z0-9_])(order|id|uid|no\.?|number|ticket|invoice)$/iu.exec(label);
  if (!idLabel) return true;
  // “phone no.”中的 no 属于号码标签，不属于业务编号。
  return /^(?:no\.?|number)$/iu.test(idLabel[1]!) && phoneField(label.slice(0, idLabel.index));
}
