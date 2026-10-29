export interface RuleHit {
  start: number;
  end: number;
  kind: string;
}

interface Rule {
  kind: string;
  re: RegExp;
  /** 正则里取第几个捕获组做值；0 表示整个匹配。 */
  group?: number;
  /** 值两侧不得紧挨这些字符（避免命中更长单词里的片段）。 */
  bound?: string;
  /** 额外的语义校验。 */
  ok?: (value: string) => boolean;
  /** 按上下文判断（如 IP 前是 version/build 就不算）。 */
  at?: (text: string, start: number) => boolean;
}

const ALNUM = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
const TOKEN_CH = `${ALNUM}_-`;
const DIGITS = "0123456789";
const MONTHS = String.raw`(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?`;
/** 标签与值之间可选的冒号/等号/空格。 */
const SEP = String.raw`["']?[ \t]*(?:[:#=：][ \t]*)?`;

/** 字段名里表示「这是密钥」的名字。 */
const SECRET_FIELD = String.raw`(?:password|passwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|credential)`;
const QUOTE = String.raw`(?:\\?["'])?`;
const SECRET_CH = String.raw`[A-Za-z0-9_\-./+=~!@#%^&*]`;

function notAVariable(value: string): boolean {
  if (value.length === 0) return false;
  if ("$%{<[*".includes(value[0]!)) return false;
  return value.replace(/[*xX.]+/gu, "").length > 0;
}

function secretValue(value: string): boolean {
  if (!notAVariable(value)) return false;
  return /[0-9]/u.test(value) && /[A-Za-z]/u.test(value);
}

const FILE_EXT = new Set([
  "jpg", "jpeg", "png", "gif", "webp", "svg", "pdf", "mp4", "mov", "webm", "md", "json", "yaml", "yml",
  "toml", "xml", "txt", "csv", "js", "mjs", "cjs", "ts", "tsx", "jsx", "css", "scss", "html", "htm", "zip"
]);

const DOC_FILES = new Set(["agents.md", "claude.md", "readme.md", "gemini.md", "skill.md", "license.md", "contributing.md", "todo.md"]);

/** 邮箱：排除 git@、文件扩展名、示例域名、文档文件名。 */
function realEmail(value: string): boolean {
  const at = value.lastIndexOf("@");
  if (at < 1) return false;
  const host = value.slice(at + 1).toLowerCase();
  const local = value.slice(0, at).toLowerCase();
  if (local === "git") return false;
  const tld = host.slice(host.lastIndexOf(".") + 1);
  if (FILE_EXT.has(tld) || DOC_FILES.has(host)) return false;
  if (host === "example.com" || host === "example.org" || host === "example.net" || host === "localhost") return false;
  if (host.startsWith("noreply") || value.includes("noreply@")) return false;
  return /^[a-z]{2,}$/u.test(tld);
}

/** 中国大陆身份证：18 位 + 校验位。 */
function chineseId(value: string): boolean {
  if (!/^[1-9]\d{5}(?:18|19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{3}[\dXx]$/u.test(value)) return false;
  const weights = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2];
  let sum = 0;
  for (let i = 0; i < 17; i += 1) sum += Number(value[i]) * weights[i]!;
  return String(value[17]).toUpperCase() === "10X98765432"[sum % 11];
}

/** 银行卡：Luhn 校验，15–19 位。 */
function luhn(value: string): boolean {
  const digits = value.replace(/\D/gu, "");
  if (digits.length < 15 || digits.length > 19) return false;
  let sum = 0;
  for (let i = 0; i < digits.length; i += 1) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return sum % 10 === 0;
}

/** 美国社会安全号：在 SSA 发放的号段里。 */
function ssnOk(value: string): boolean {
  const d = value.replace(/[-\s]/gu, "");
  if (d.length !== 9) return false;
  if (d.slice(0, 3) === "000" || d.slice(0, 3) === "666" || d[0] === "9") return false;
  if (d.slice(3, 5) === "00" || d.slice(5) === "0000") return false;
  return new Set(["123456789", "078051120", "219099999"]).has(d) === false && d.replace(new RegExp(d[0]!, "giu"), "") !== "";
}

/** 护照号：6–9 位字母数字，至少 5 位数字。 */
function passportOk(value: string): boolean {
  const digits = value.replace(/[^0-9]/gu, "").length;
  return digits >= 5 && value.replace(new RegExp(value[0]!, "giu"), "") !== "";
}

/** 各国 IBAN 的长度。 */
const IBAN_LEN: Record<string, number> = {
  AD: 24, AE: 23, AL: 28, AT: 20, AZ: 28, BA: 20, BE: 16, BG: 22, BH: 22, BR: 29, BY: 28, CH: 21, CR: 22,
  CY: 28, CZ: 24, DE: 22, DK: 18, DO: 28, EE: 20, EG: 29, ES: 24, FI: 18, FO: 18, FR: 27, GB: 22, GE: 22,
  GI: 23, GL: 18, GR: 27, GT: 28, HR: 21, HU: 28, IE: 22, IL: 23, IQ: 23, IS: 26, IT: 27, JO: 30, KW: 30,
  KZ: 20, LB: 28, LC: 32, LI: 21, LT: 20, LU: 20, LV: 21, LY: 25, MC: 27, MD: 24, ME: 22, MK: 19, MR: 27,
  MT: 31, MU: 30, NL: 18, NO: 15, PK: 24, PL: 28, PS: 29, PT: 25, QA: 29, RO: 24, RS: 22, SA: 24, SC: 31,
  SE: 24, SI: 19, SK: 24, SM: 27, ST: 25, SV: 28, TL: 23, TN: 24, TR: 26, UA: 29, VA: 22, VG: 24, XK: 20
};

/** IBAN：长度匹配且 mod 97 == 1。 */
function ibanOk(raw: string): boolean {
  const v = raw.replace(/\s/gu, "");
  const len = IBAN_LEN[v.slice(0, 2)];
  if (len === undefined || len !== v.length || !/^[A-Z0-9]+$/u.test(v)) return false;
  const r = v.slice(4) + v.slice(0, 4);
  let m = 0;
  for (const c of r) {
    if (c >= "0" && c <= "9") m = (m * 10 + Number(c)) % 97;
    else m = (m * 100 + c.charCodeAt(0) - 55) % 97;
  }
  return m === 1;
}

/** 生日：真实月日、1900–2099 年、且早于一年前（今天/未来多半是日志或截止日）。 */
function birthdayOk(value: string): boolean {
  const ns = (value.match(/\d+/gu) ?? []).map(Number);
  const oneYearAgo = new Date();
  oneYearAgo.setFullYear(oneYearAgo.getFullYear() - 1);
  const valid = (y: number, mo: number, d: number): boolean => {
    const date = new Date(y, mo - 1, d);
    return y >= 1900 && y <= 2099 && date.getFullYear() === y && date.getMonth() === mo - 1
      && date.getDate() === d && date < oneYearAgo;
  };
  if (ns.length === 2) {
    const lower = value.toLowerCase();
    const names = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
    const idx = names.findIndex((name) => lower.includes(name));
    if (idx < 0) return false;
    let d = ns[0]!, y = ns[1]!;
    if (String(ns[0]).length === 4) [d, y] = [y, d];
    return valid(y, idx + 1, d);
  }
  if (ns.length !== 3) return false;
  if (String(ns[0]).length === 4) return valid(ns[0]!, ns[1]!, ns[2]!);
  return valid(ns[2]!, ns[0]!, ns[1]!) || valid(ns[2]!, ns[1]!, ns[0]!);
}

const MAC_BLOCKLIST = new Set([
  "00:00:00:00:00:00", "ff:ff:ff:ff:ff:ff", "00:11:22:33:44:55", "aa:bb:cc:dd:ee:ff",
  "01:23:45:67:89:ab", "12:34:56:78:9a:bc", "xx:xx:xx:xx:xx:xx"
]);
function macOk(value: string): boolean {
  const l = value.replace(/-/gu, ":").toLowerCase();
  return !MAC_BLOCKLIST.has(l) && /[abcdef]/u.test(l);
}

function serialOk(value: string): boolean {
  return value.length >= 6 && /\d/u.test(value) && value.replace(new RegExp(value[0]!, "giu"), "") !== "";
}

/** 用户名：排除服务/系统账号与常见代词。 */
const NOT_USERS = new Set([
  "git", "root", "ec2-user", "ubuntu", "admin", "postgres", "www-data", "nobody", "centos", "debian", "fedora",
  "azureuser", "opc", "core", "vagrant", "docker", "str", "string", "int", "bool", "any", "none", "null", "nil",
  "true", "false", "undefined", "hi", "hello", "hey", "yes", "no", "ok", "okay", "thanks", "continue", "go", "stop", "help", "test"
]);
function userOk(value: string): boolean {
  return value.length >= 2 && !NOT_USERS.has(value.toLowerCase());
}

/** 私网/保留网段，不算个人信息。 */
const NOT_IP: RegExp[] = [
  /^10\./u, /^127\./u, /^192\.168\./u, /^172\.(?:1[6-9]|2\d|3[01])\./u, /^169\.254\./u,
  /^0\./u, /^100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./u, /^198\.(?:18|19)\./u,
  /^192\.0\.2\./u, /^198\.51\.100\./u, /^203\.0\.113\./u, /^22[4-9]\./u, /^2[3-5]\d\./u
];
const RESOLVERS = new Set(["8.8.8.8", "8.8.4.4", "1.1.1.1", "1.0.0.1", "9.9.9.9", "149.112.112.112", "114.114.114.114", "223.5.5.5", "119.29.29.29"]);
function publicIPv4(value: string): boolean {
  if (value.split(".").length !== 4) return false;
  if (RESOLVERS.has(value) || NOT_IP.some((re) => re.test(value))) return false;
  return value.split(".").every((part) => {
    const n = Number(part);
    return Number.isInteger(n) && n >= 0 && n <= 255;
  });
}
/** 版本号/构建号后的点分数字不算 IP。 */
function ipv4At(text: string, start: number): boolean {
  const before = text.slice(Math.max(0, start - 16), start).toLowerCase().replace(/[ \t:="']+$/u, "");
  return !/(?:version|ver|release|build|rev|版本)$/u.test(before);
}

/** 云存储桶：示例桶名不算。 */
const NOT_BUCKETS = new Set([
  "bucket", "my-bucket", "mybucket", "bucket-name", "bucketname", "your-bucket", "yourbucket", "example-bucket",
  "examplebucket", "s3", "www", "storage", "container", "mycontainer", "my-container", "account", "upload", "download", "api", "v1", "v2"
]);
function bucketOk(value: string): boolean {
  const l = value.toLowerCase();
  return l.length >= 3 && !NOT_BUCKETS.has(l) && /[^0-9]/u.test(l);
}

const RULES: readonly Rule[] = [
  { kind: "SECRET", re: /(?:密码|密碼|密钥|金鑰|パスワード)[ \t]*(?:[:=：]|是|为|為)[ \t]*["']?([^\s"'<>{}]{4,})/gu, group: 1, ok: notAVariable },
  {
    kind: "PRIVATE_KEY",
    re: /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----[\s\S]+?-----END (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----/gu
  },
  { kind: "API_KEY", re: /sk-(?:ant-|proj-|or-|svcacct-|admin-)?[A-Za-z0-9_-]{20,}/gu, bound: TOKEN_CH },
  {
    kind: "API_KEY",
    re: /(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,}|glpat-[A-Za-z0-9_-]{20,})/gu,
    bound: TOKEN_CH
  },
  { kind: "API_KEY", re: /AIza[0-9A-Za-z_-]{35}/gu, bound: TOKEN_CH },
  { kind: "API_KEY", re: /xox[abposr]-[0-9A-Za-z-]{10,}/gu, bound: TOKEN_CH },
  { kind: "API_KEY", re: /(?:sk|rk)_live_[0-9A-Za-z]{20,}/gu, bound: TOKEN_CH },
  { kind: "API_KEY", re: /(?:AKIA|ASIA)[0-9A-Z]{16}/gu, bound: ALNUM },
  {
    kind: "API_KEY",
    re: /(?:hf_[A-Za-z0-9]{30,}|gsk_[A-Za-z0-9]{40,}|xai-[A-Za-z0-9]{40,}|npm_[A-Za-z0-9]{36}|dop_v1_[a-f0-9]{64}|SG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43})/gu,
    bound: TOKEN_CH
  },
  { kind: "TOKEN", re: /eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/gu, bound: TOKEN_CH },
  {
    kind: "PASSWORD",
    re: /[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s:@/?#"'<>]*:([^\s@/?#"'<>]{3,})@/gu,
    group: 1,
    ok: notAVariable
  },
  {
    kind: "SECRET",
    re: new RegExp(`${SECRET_FIELD}${QUOTE}[ \\t]*[:=][ \\t]*${QUOTE}(${SECRET_CH}{8,})`, "giu"),
    group: 1,
    ok: secretValue
  },

  {
    kind: "EMAIL",
    re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/gu,
    bound: `${ALNUM}_%+-`,
    ok: realEmail
  },
  {
    kind: "ID_CARD",
    re: /[1-9]\d{5}(?:18|19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{3}[\dXx]/gu,
    bound: ALNUM,
    ok: chineseId
  },
  { kind: "PHONE", re: /(?:\+?86[- ]?)?1[3-9]\d{9}/gu, bound: DIGITS },
  { kind: "BANK_CARD", re: /[3-6]\d{3}(?:[ -]?\d{4}){2,3}(?:[ -]?\d{1,3})?/gu, bound: DIGITS, ok: luhn },

  { kind: "SSN", re: /\d{3}-\d{2}-\d{4}/gu, bound: `${ALNUM}-`, ok: ssnOk },
  {
    kind: "PASSPORT",
    re: new RegExp(String.raw`(?:\bpassport(?:[ \t]*(?:no\.?|number|num|#))?)${SEP}(?:(?:is|was)[ \t]+)?["']?([A-Z0-9]{6,9})`, "giu"),
    group: 1,
    bound: ALNUM,
    ok: passportOk
  },
  { kind: "IBAN", re: /[A-Z]{2}\d{2}(?:[A-Z0-9]{11,30}|(?: [A-Z0-9]{4}){2,7}(?: [A-Z0-9]{1,3})?)/gu, bound: ALNUM, ok: ibanOk },
  {
    kind: "BIRTHDAY",
    re: new RegExp(
      String.raw`(?:\bdate[ \t]+of[ \t]+birth|\bbirth[ \t_-]?date|\bbirthday|\bdob\b|\bborn(?:[ \t]+on)?|生日|出生日期|出生年月日|出生于|出生於)` +
      SEP + String.raw`(?:(?:is|was)[ \t]+|是[ \t]*|为[ \t]*|為[ \t]*)?["']?` +
      String.raw`(\d{4}[-/.]\d{1,2}[-/.]\d{1,2}|\d{4}[ \t]*年[ \t]*\d{1,2}[ \t]*月[ \t]*\d{1,2}[ \t]*日?|\d{1,2}[-/.]\d{1,2}[-/.]\d{4}|` +
      MONTHS + String.raw`[ \t]+\d{1,2}(?:st|nd|rd|th)?,?[ \t]+\d{4}|\d{1,2}(?:st|nd|rd|th)?[ \t]+` + MONTHS + String.raw`[ \t]+\d{4})`,
      "giu"
    ),
    group: 1,
    bound: DIGITS,
    ok: birthdayOk
  },
  { kind: "MAC", re: /(?:[0-9A-Fa-f]{2}(?::[0-9A-Fa-f]{2}){5}|[0-9A-Fa-f]{2}(?:-[0-9A-Fa-f]{2}){5})/gu, bound: `${ALNUM}:-`, ok: macOk },
  {
    kind: "SERIAL",
    re: new RegExp(String.raw`(?:\bserial[ \t_-]?(?:number|num|no\.?|#)?|\bs/n|\bsn)(?:[ \t]*\([^)\n]{1,20}\))?["']?[ \t]*[:#=：][ \t]*["']?([A-Za-z0-9][A-Za-z0-9-]{4,39})`, "giu"),
    group: 1,
    bound: `${ALNUM}-`,
    ok: serialOk
  },
  {
    kind: "USERNAME",
    re: /(?:\b(?:ssh|scp|sftp|rsync|mosh)\b)[^\n@]{0,80}?[ \t"']([a-z_][a-z0-9_.-]{1,31})@([A-Za-z0-9][A-Za-z0-9-]{0,62}(?:\.[A-Za-z0-9-]{1,63})*)/giu,
    group: 1,
    ok: userOk
  },
  {
    kind: "IP",
    re: /(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(?:\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}/gu,
    bound: `${ALNUM}.-=_~^`,
    ok: publicIPv4,
    at: ipv4At
  },
  {
    kind: "BUCKET",
    re: /(?:\b(?:s3a?|s3n|gs|oss|cosn?|obs|r2|ks3|bos|tos|az|azure|wasbs?|abfss?):\/\/)([a-z0-9](?:[a-z0-9._-]{0,61}[a-z0-9])?)/giu,
    group: 1,
    ok: bucketOk
  }
];

/** 遍历所有规则，收集命中；bound、ok、at 在同一处判定。 */
export function findRuleHits(text: string): RuleHit[] {
  const hits: RuleHit[] = [];
  for (const rule of RULES) {
    rule.re.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = rule.re.exec(text)) !== null) {
      const group = rule.group ?? 0;
      const value = match[group];
      if (value === undefined || value.length === 0) continue;
      const start = match.index + (group === 0 ? 0 : match[0].indexOf(value));
      const end = start + value.length;
      const bound = rule.bound;
      if (bound && ((start > 0 && bound.includes(text[start - 1]!)) || (end < text.length && bound.includes(text[end]!)))) {
        continue;
      }
      if (rule.ok && !rule.ok(value)) continue;
      if (rule.at && !rule.at(text, start)) continue;
      hits.push({ start, end, kind: rule.kind });
    }
  }
  return hits;
}
