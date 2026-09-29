/**
 * 出网目标地址校验模块。
 *
 * `WebFetch` 的 URL 是模型给的，等于把一个任意出网请求交到模型手上。没有这道校验，它
 * 就成了打进本机和内网的入口：`http://localhost:*` 的开发服务、`169.254.169.254` 的云
 * 元数据服务（里面通常有实例凭证）、`10./172.16./192.168.` 的内网服务。
 *
 * 做法是先解析域名再逐个校验解析出的 IP，而不是只看域名字面 —— 否则一个解析到
 * 127.0.0.1 的公网域名就能绕过去。
 *
 * 残留风险（不假装解决）：校验和真正建连之间存在 DNS 重绑定窗口。彻底堵住需要按已校验
 * 的 IP 建连并自带 Host/SNI，那会绕开标准 fetch 的证书校验路径，代价更大。当前实现挡住
 * 的是误用和模型自己想出来的内网地址，不是有针对性的主动攻击。
 */
import { lookup } from "node:dns/promises";
import net from "node:net";

export class BlockedAddressError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BlockedAddressError";
  }
}

export type HostnameResolver = (hostname: string) => Promise<string[]>;

export interface AddressPolicy {
  /** 放开私网/环回校验。只应在用户明确为本地服务开启时使用。 */
  allowPrivateNetwork?: boolean;
  /** 测试可注入确定性解析结果；生产默认使用系统 DNS。 */
  resolveHostname?: HostnameResolver;
}

export async function assertFetchableUrl(url: URL, policy: AddressPolicy = {}): Promise<void> {
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new BlockedAddressError(`Only http and https URLs can be fetched: ${url.protocol}//`);
  }
  if (url.username || url.password) {
    throw new BlockedAddressError("URLs carrying inline credentials are refused.");
  }
  if (policy.allowPrivateNetwork) return;

  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  const addresses = net.isIP(hostname)
    ? [hostname]
    : await (policy.resolveHostname ?? resolveHostnameWithSystemDns)(hostname);
  if (!addresses.length) throw new BlockedAddressError(`Host did not resolve: ${url.hostname}`);
  for (const address of addresses) {
    const reason = blockedAddressReason(address);
    if (reason) throw new BlockedAddressError(`Refused to fetch ${url.hostname}: it resolves to ${address}, ${reason}.`);
  }
}

async function resolveHostnameWithSystemDns(hostname: string): Promise<string[]> {
  return (await lookup(hostname, { all: true })).map((entry) => entry.address);
}

export function blockedAddressReason(address: string): string | undefined {
  const version = net.isIP(address);
  if (!version) return "which is not a valid IP address";
  return blockedNetworks.find(({ blockList }) => blockList.check(address, version === 4 ? "ipv4" : "ipv6"))?.reason;
}

// 按地址字节匹配，避免 URL 将点分 IPv4 映射成十六进制 IPv6 后绕过字符串判断。
const blockedNetworks = ([
  ["0.0.0.0", 8, "ipv4", "an unspecified address"],
  ["127.0.0.0", 8, "ipv4", "a loopback address"],
  ["10.0.0.0", 8, "ipv4", "a private network address"],
  ["172.16.0.0", 12, "ipv4", "a private network address"],
  ["192.168.0.0", 16, "ipv4", "a private network address"],
  ["169.254.0.0", 16, "ipv4", "a link-local address (cloud instance metadata lives here)"],
  ["100.64.0.0", 10, "ipv4", "a carrier-grade NAT address"],
  ["192.0.0.0", 16, "ipv4", "a reserved address"],
  ["224.0.0.0", 3, "ipv4", "a multicast or reserved address"],
  ["::", 128, "ipv6", "an unspecified address"],
  ["::1", 128, "ipv6", "a loopback address"],
  ["fc00::", 7, "ipv6", "a unique local address"],
  ["fe80::", 10, "ipv6", "a link-local address"],
  ["ff00::", 8, "ipv6", "a multicast address"]
] as const).map(([subnet, prefix, family, reason]) => {
  const blockList = new net.BlockList();
  blockList.addSubnet(subnet, prefix, family);
  return { blockList, reason };
});
