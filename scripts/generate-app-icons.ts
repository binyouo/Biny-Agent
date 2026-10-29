import { writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// 两帧共用 824/1024 底板、圆角与外边距，避免 Dock 眨眼时轮廓和视觉尺寸变化。
const mask = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="824" height="824"><rect width="824" height="824" rx="185" fill="white"/></svg>');
async function renderIcon(filename: string): Promise<Buffer> {
  const tile = await sharp(path.join(root, "build", filename)).resize(824, 824)
    .composite([{ input: mask, blend: "dest-in" }]).png().toBuffer();
  return await sharp({ create: { width: 1024, height: 1024, channels: 4, background: "#00000000" } })
    .composite([{ input: tile, left: 100, top: 100 }]).png().toBuffer();
}
const master = await renderIcon("icon-source.png");
const png = async (size: number): Promise<Buffer> => await sharp(master).resize(size, size).png().toBuffer();
await writeFile(path.join(root, "build/icon-master.png"), master);
await writeFile(path.join(root, "build/icon-blink.png"), await renderIcon("icon-blink-source.png"));
// 应用内头像与标签页不带 Dock 外边距，小尺寸时保留脸部的实际显示面积。
await sharp(path.join(root, "build/icon-source.png")).resize(64, 64).png().toFile(path.join(root, "src/desktop/renderer/public/favicon.png"));
for (const [input, output] of [["icon-source.png", "app-icon.png"], ["icon-blink-source.png", "app-icon-blink.png"]]) {
  await sharp(path.join(root, "build", input)).resize(256, 256).png().toFile(path.join(root, "src/desktop/renderer/src/assets", output));
}

const chunks: Buffer[] = [];
for (const [kind, size] of [["icp4", 16], ["icp5", 32], ["icp6", 64], ["ic07", 128], ["ic08", 256], ["ic09", 512], ["ic10", 1024]] as const) {
  const data = await png(size);
  const header = Buffer.alloc(8);
  header.write(kind);
  header.writeUInt32BE(8 + data.length, 4);
  chunks.push(header, data);
}
const icnsHeader = Buffer.alloc(8);
icnsHeader.write("icns");
icnsHeader.writeUInt32BE(8 + chunks.reduce((total, chunk) => total + chunk.length, 0), 4);
await writeFile(path.join(root, "build/icon.icns"), Buffer.concat([icnsHeader, ...chunks]));

const sizes = [16, 24, 32, 48, 64, 128, 256];
const icoHeader = Buffer.alloc(6 + sizes.length * 16);
icoHeader.writeUInt16LE(1, 2);
icoHeader.writeUInt16LE(sizes.length, 4);
const images: Buffer[] = [];
let offset = icoHeader.length;
for (const [index, size] of sizes.entries()) {
  const data = await png(size);
  const entry = 6 + index * 16;
  icoHeader[entry] = size === 256 ? 0 : size;
  icoHeader[entry + 1] = size === 256 ? 0 : size;
  icoHeader.writeUInt16LE(1, entry + 4);
  icoHeader.writeUInt16LE(32, entry + 6);
  icoHeader.writeUInt32LE(data.length, entry + 8);
  icoHeader.writeUInt32LE(offset, entry + 12);
  images.push(data);
  offset += data.length;
}
await writeFile(path.join(root, "build/icon.ico"), Buffer.concat([icoHeader, ...images]));
console.log("Generated Biny PNG, ICNS, ICO and favicon.");
