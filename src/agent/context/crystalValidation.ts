/** 结晶确认资格的纯校验；服务端闸门与桌面展示共用，不引入存储或模型。 */
import { crystalTypeFields, type Crystal } from "./crystalTypes.js";

export interface CrystalValidation {
  ready: boolean;
  missing: string[];
  conflicted: string[];
}

export function validateCrystal(crystal: Crystal): CrystalValidation {
  if (!crystal.type) return { ready: false, missing: ["type"], conflicted: [] };
  const missing: string[] = [];
  const conflicted: string[] = [];
  for (const field of crystalTypeFields[crystal.type]) {
    const item = crystal.checklist[field];
    if (!item?.value.trim() || !item.sources.length) missing.push(field);
    else if (item.conflict) conflicted.push(field);
  }
  return { ready: missing.length === 0 && conflicted.length === 0, missing, conflicted };
}
