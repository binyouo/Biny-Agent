import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { PocketSpiritArtwork } from "../src/desktop/renderer/src/components/PocketSpiritArtwork.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const markup = renderToStaticMarkup(<PocketSpiritArtwork id="biny-icon" tile />);
const variables = new Map([...markup.matchAll(/(--fold-[\w-]+):([^;"}]+)/gu)].map(match => [match[1], match[2]]));
const svg = markup.replace('<svg ', '<svg xmlns="http://www.w3.org/2000/svg" ')
  .replace('width="100%" height="100%"', 'width="1024" height="1024"')
  .replace('class="fold-closed-eyes"', 'class="fold-closed-eyes" opacity="0"')
  .replace(/var\((--fold-[\w-]+)\)/gu, (_match, name: string) => {
    const value = variables.get(name);
    if (!value) throw new Error(`Missing icon color: ${name}`);
    return value;
  });
const png = async (size: number): Promise<Buffer> => await sharp(Buffer.from(svg)).resize(size, size).png().toBuffer();
await writeFile(path.join(root, "build/icon-master.png"), await png(1024));
await writeFile(path.join(root, "src/desktop/renderer/public/favicon.png"), await png(64));

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
console.log("Generated Biny PNG, ICNS, ICO and favicon from PocketSpiritArtwork.");
