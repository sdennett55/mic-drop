const fs = require('node:fs');
const path = require('node:path');
const { PNG } = require('pngjs');

const outputDir = path.join(__dirname, '..', 'build');
const pngPath = path.join(outputDir, 'icon.png');
const icoPath = path.join(outputDir, 'icon.ico');
const size = 256;
const png = new PNG({ width: size, height: size });

function roundedRect(x, y, width, height, radius) {
  const closestX = Math.max(x + radius, Math.min(size / 2, x + width - radius));
  const closestY = Math.max(y + radius, Math.min(size / 2, y + height - radius));
  return (pixelX, pixelY) => {
    const cx = Math.max(x + radius, Math.min(pixelX, x + width - radius));
    const cy = Math.max(y + radius, Math.min(pixelY, y + height - radius));
    return (pixelX - cx) ** 2 + (pixelY - cy) ** 2 <= radius ** 2 ||
      (pixelX >= x + radius && pixelX <= x + width - radius && pixelY >= y && pixelY <= y + height) ||
      (pixelY >= y + radius && pixelY <= y + height - radius && pixelX >= x && pixelX <= x + width);
  };
}

const inside = roundedRect(9, 9, 238, 238, 53);
for (let y = 0; y < size; y++) {
  for (let x = 0; x < size; x++) {
    const index = (size * y + x) << 2;
    if (!inside(x, y)) {
      png.data[index + 3] = 0;
      continue;
    }
    const radial = Math.max(0, 1 - Math.hypot(x - 130, y - 108) / 185);
    const vertical = y / size;
    png.data[index] = Math.round(38 + radial * 69 + vertical * 10);
    png.data[index + 1] = Math.round(25 + radial * 35);
    png.data[index + 2] = Math.round(70 + radial * 112);
    png.data[index + 3] = 255;
  }
}

function paintRect(x, y, width, height, radius, color) {
  const contains = roundedRect(x, y, width, height, radius);
  for (let py = Math.max(0, y); py < Math.min(size, y + height); py++) {
    for (let px = Math.max(0, x); px < Math.min(size, x + width); px++) {
      if (!contains(px, py)) continue;
      const index = (size * py + px) << 2;
      png.data[index] = color[0];
      png.data[index + 1] = color[1];
      png.data[index + 2] = color[2];
      png.data[index + 3] = color[3] ?? 255;
    }
  }
}

const bars = [42, 77, 119, 158, 119, 77, 42];
const barWidth = 14;
const gap = 10;
const totalWidth = bars.length * barWidth + (bars.length - 1) * gap;
let startX = Math.round((size - totalWidth) / 2);
bars.forEach((height, index) => {
  const x = startX + index * (barWidth + gap);
  paintRect(x, Math.round((size - height) / 2), barWidth, height, 7, [247, 245, 255, 255]);
});

fs.mkdirSync(outputDir, { recursive: true });

async function generateIcon() {
  await new Promise((resolve, reject) => {
    png.pack()
      .pipe(fs.createWriteStream(pngPath))
      .on('finish', resolve)
      .on('error', reject);
  });

  const { default: pngToIco } = await import('png-to-ico');
  const ico = await pngToIco([pngPath]);
  fs.writeFileSync(icoPath, ico);
}

generateIcon().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
