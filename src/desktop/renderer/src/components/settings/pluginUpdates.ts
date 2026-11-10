/**
 * 已安装 Plugin 与市场版本的比较。
 *
 * 比较只决定“可更新”标记：市场版本严格更小时不提示，相等或解析不出差异都不显示更新。
 */
import type { DesktopPluginMarketEntry, DesktopPluginSummary } from "../../../../protocol.js";

export function comparePluginVersions(left: string, right: string): number {
  const a = splitVersion(left);
  const b = splitVersion(right);
  if (a === undefined || b === undefined) return 0;
  for (let index = 0; index < 3; index++) {
    const comparison = compareIdentifier(a.core[index] ?? "0", b.core[index] ?? "0");
    if (comparison !== 0) return comparison;
  }
  if (a.prerelease === undefined && b.prerelease === undefined) return 0;
  // 无 prerelease 视为正式发布，高于同核心的预发布。
  if (a.prerelease === undefined) return 1;
  if (b.prerelease === undefined) return -1;
  for (let index = 0; index < Math.max(a.prerelease.length, b.prerelease.length); index++) {
    const leftPart = a.prerelease[index];
    const rightPart = b.prerelease[index];
    if (leftPart === undefined) return -1;
    if (rightPart === undefined) return 1;
    const comparison = compareIdentifier(leftPart, rightPart);
    if (comparison !== 0) return comparison;
  }
  return 0;
}

/** 受管已安装插件在市场里有更新版本时返回该版本号，否则返回 undefined。 */
export function pluginUpdateVersion(plugin: DesktopPluginSummary, market: readonly DesktopPluginMarketEntry[]): string | undefined {
  if (!plugin.managed || plugin.pluginId === undefined || plugin.version === undefined) return undefined;
  const entry = market.find(candidate => candidate.id === plugin.pluginId);
  return entry !== undefined && comparePluginVersions(entry.version, plugin.version) > 0 ? entry.version : undefined;
}

function splitVersion(version: string): { core: string[]; prerelease?: string[] } | undefined {
  const match = /^[vV]?((?:0|[1-9]\d*)(?:\.(?:0|[1-9]\d*)){0,2})(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u.exec(version.trim());
  if (!match) return undefined;
  const prerelease = match[2]?.split(".");
  if (prerelease?.some(part => /^0\d+$/u.test(part))) return undefined;
  return { core: match[1]!.split("."), prerelease };
}

function compareIdentifier(left: string, right: string): number {
  const leftNumeric = /^\d+$/u.test(left);
  const rightNumeric = /^\d+$/u.test(right);
  if (leftNumeric && rightNumeric) return BigInt(left) < BigInt(right) ? -1 : BigInt(left) > BigInt(right) ? 1 : 0;
  if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
  return left < right ? -1 : left > right ? 1 : 0;
}
