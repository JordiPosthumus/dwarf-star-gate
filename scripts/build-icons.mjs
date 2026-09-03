// Development-only SVG rasterization. Sharp is NOT a gateway/runtime dependency.
// Run with sharp available to Node (e.g. in a separate asset-build environment).
import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
const sharp=createRequire(import.meta.url)('sharp');
const directory=fileURLToPath(new URL('../ds4-gateway/ui/',import.meta.url));
const mask=fs.readFileSync(path.join(directory,'dsg-pinned-v1.svg'),'utf8');
// Same gate + star silhouette, a high-contrast tile for non-mask contexts.
const svg=mask.replace('<g fill="#000000">','<rect width="64" height="64" rx="12" fill="#d7efa3"/><g fill="#101514">');
fs.writeFileSync(path.join(directory,'favicon-v1.svg'),svg);
const rendered=new Map();
for(const size of [16,32,180])rendered.set(size,await sharp(Buffer.from(svg)).resize(size,size).png().toBuffer());
fs.writeFileSync(path.join(directory,'favicon-v1.png'),rendered.get(32));
fs.writeFileSync(path.join(directory,'apple-touch-icon.png'),rendered.get(180));
const images=[rendered.get(16),rendered.get(32)],header=Buffer.alloc(6+16*images.length);
header.writeUInt16LE(1,2);header.writeUInt16LE(images.length,4);let offset=header.length;
for(const [index,bytes] of images.entries()) {
  const entry=6+index*16,size=[16,32][index];header[entry]=size;header[entry+1]=size;
  header.writeUInt16LE(1,entry+4);header.writeUInt16LE(32,entry+6);header.writeUInt32LE(bytes.length,entry+8);header.writeUInt32LE(offset,entry+12);offset+=bytes.length;
}
fs.writeFileSync(path.join(directory,'favicon.ico'),Buffer.concat([header,...images]));
console.log('Built SVG, 16/32px ICO, 32px PNG and 180px Apple touch icon from the gate mask.');
