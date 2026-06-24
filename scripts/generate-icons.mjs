#!/usr/bin/env node
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const assetsDir = join(repoRoot, 'assets', 'images');
const markPath = join(assetsDir, 'logo.svg');
const tmpDir = join(repoRoot, '.tmp-icons');

if (!existsSync(markPath)) {
  throw new Error(`Missing source mark: ${markPath}`);
}

const markHref = `file://${markPath}`;

const run = (cmd, args, options = {}) => {
  const result = spawnSync(cmd, args, {
    cwd: options.cwd ?? repoRoot,
    encoding: 'utf8',
    stdio: options.stdio ?? 'pipe',
  });
  if (result.status !== 0) {
    throw new Error(`${cmd} ${args.join(' ')} failed\n${result.stdout ?? ''}${result.stderr ?? ''}`);
  }
  return result;
};

const renderSvg = (svg, outputPng, size = 1024) => {
  mkdirSync(tmpDir, { recursive: true });
  const source = join(tmpDir, `${basename(outputPng, '.png')}.svg`);
  const rendered = `${source}.png`;
  rmSync(rendered, { force: true });
  writeFileSync(source, svg);
  run('qlmanage', ['-t', '-s', String(size), '-o', tmpDir, source]);
  rmSync(outputPng, { force: true });
  renameSync(rendered, outputPng);
};

const resizePng = (source, output, size) => {
  mkdirSync(dirname(output), { recursive: true });
  copyFileSync(source, output);
  run('sips', ['-z', String(size), String(size), output]);
};

const pngSize = (path) => {
  const png = PNG.sync.read(readFileSync(path));
  return { width: png.width, height: png.height };
};

const resizeLikeExisting = (source, output) => {
  const { width, height } = pngSize(output);
  mkdirSync(dirname(output), { recursive: true });
  copyFileSync(source, output);
  run('sips', ['-z', String(height), String(width), output]);
};

const flattenPng = (path, bg = { r: 255, g: 254, b: 253 }) => {
  const png = PNG.sync.read(readFileSync(path));
  for (let offset = 0; offset < png.data.length; offset += 4) {
    const alpha = png.data[offset + 3] / 255;
    png.data[offset] = Math.round(png.data[offset] * alpha + bg.r * (1 - alpha));
    png.data[offset + 1] = Math.round(png.data[offset + 1] * alpha + bg.g * (1 - alpha));
    png.data[offset + 2] = Math.round(png.data[offset + 2] * alpha + bg.b * (1 - alpha));
    png.data[offset + 3] = 255;
  }
  writeFileSync(path, PNG.sync.write(png, { colorType: 2 }));
};

const copyDirFiles = (sourceDir, outputDir) => {
  mkdirSync(outputDir, { recursive: true });
  for (const entry of readdirSync(sourceDir, { withFileTypes: true })) {
    const source = join(sourceDir, entry.name);
    const output = join(outputDir, entry.name);
    if (entry.isDirectory()) {
      copyDirFiles(source, output);
    } else {
      copyFileSync(source, output);
    }
  }
};

const generateIosIconSet = (outputDir, sourcePng, contentsPath, options = {}) => {
  mkdirSync(outputDir, { recursive: true });
  const contents = JSON.parse(readFileSync(contentsPath, 'utf8'));
  if (options.writeContentsJson ?? true) {
    writeFileSync(join(outputDir, 'Contents.json'), JSON.stringify(contents, null, 2));
  }
  for (const image of contents.images ?? []) {
    if (!image.filename) {
      continue;
    }
    const points = Number.parseFloat(String(image.size).split('x')[0]);
    const scale = Number.parseFloat(String(image.scale).replace('x', ''));
    const pixels = Math.round(points * scale);
    const output = join(outputDir, image.filename);
    resizePng(sourcePng, output, pixels);
    flattenPng(output);
  }
};

const writeAndroidBackground = (outputDir) => {
  const valuesDir = join(outputDir, 'values');
  mkdirSync(valuesDir, { recursive: true });
  writeFileSync(
    join(valuesDir, 'ic_launcher_background.xml'),
    `<?xml version="1.0" encoding="utf-8"?>
<resources>
  <color name="ic_launcher_background">#fffefd</color>
</resources>
`,
  );
};

const generateAndroidIcons = (outputDir, legacySourcePng, foregroundSourcePng) => {
  for (const density of ['mipmap-mdpi', 'mipmap-hdpi', 'mipmap-xhdpi', 'mipmap-xxhdpi', 'mipmap-xxxhdpi']) {
    const densityDir = join(outputDir, density);
    for (const file of ['ic_launcher.png', 'ic_launcher_round.png']) {
      const output = join(densityDir, file);
      if (existsSync(output)) {
        resizeLikeExisting(legacySourcePng, output);
      }
    }
    const foreground = join(densityDir, 'ic_launcher_foreground.png');
    if (existsSync(foreground)) {
      resizeLikeExisting(foregroundSourcePng, foreground);
    }
  }
  writeAndroidBackground(outputDir);
};

const markMask = `
    <mask id="markMask" maskUnits="userSpaceOnUse" x="0" y="0" width="1024" height="1024" mask-type="alpha">
      <image href="${markHref}" x="0" y="0" width="1024" height="1024" preserveAspectRatio="xMidYMid meet" />
    </mask>`;

const scaledMarkMask = (scale) => {
  const size = 1024 * scale;
  const offset = (1024 - size) / 2;
  return `
    <mask id="markMask" maskUnits="userSpaceOnUse" x="0" y="0" width="1024" height="1024" mask-type="alpha">
      <image href="${markHref}" x="${offset}" y="${offset}" width="${size}" height="${size}" preserveAspectRatio="xMidYMid meet" />
    </mask>`;
};

const gradient = `
    <linearGradient id="markGradient" x1="512" y1="132" x2="512" y2="892" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#ff9f00" />
      <stop offset="0.46" stop-color="#ff7a00" />
      <stop offset="1" stop-color="#ed5a00" />
    </linearGradient>`;

const squareIconSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
  <defs>${gradient}${markMask}
  </defs>
  <rect width="1024" height="1024" fill="#fffefd" />
  <rect width="1024" height="1024" fill="url(#markGradient)" mask="url(#markMask)" />
</svg>
`;

const roundedIconSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
  <defs>${gradient}${markMask}
    <clipPath id="appIconClip">
      <rect x="0" y="0" width="1024" height="1024" rx="224" ry="224" />
    </clipPath>
  </defs>
  <g clip-path="url(#appIconClip)">
    <rect width="1024" height="1024" fill="#fffefd" />
    <rect width="1024" height="1024" fill="url(#markGradient)" mask="url(#markMask)" />
  </g>
</svg>
`;

const foregroundSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
  <defs>${gradient}${markMask}
  </defs>
  <rect width="1024" height="1024" fill="url(#markGradient)" mask="url(#markMask)" />
</svg>
`;

const androidScale = 0.68;
const androidMask = scaledMarkMask(androidScale);
const androidRoundedIconSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
  <defs>${gradient}${androidMask}
    <clipPath id="appIconClip">
      <rect x="0" y="0" width="1024" height="1024" rx="224" ry="224" />
    </clipPath>
  </defs>
  <g clip-path="url(#appIconClip)">
    <rect width="1024" height="1024" fill="#fffefd" />
    <rect width="1024" height="1024" fill="url(#markGradient)" mask="url(#markMask)" />
  </g>
</svg>
`;

const androidForegroundSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
  <defs>${gradient}${androidMask}
  </defs>
  <rect width="1024" height="1024" fill="url(#markGradient)" mask="url(#markMask)" />
</svg>
`;

rmSync(tmpDir, { recursive: true, force: true });
mkdirSync(tmpDir, { recursive: true });

const squarePng = join(assetsDir, 'icon.png');
const roundedPng = join(tmpDir, 'icon-rounded.png');
const foregroundPng = join(tmpDir, 'icon-foreground.png');
const androidRoundedPng = join(tmpDir, 'icon-android-rounded.png');
const androidForegroundPng = join(tmpDir, 'icon-android-foreground.png');

renderSvg(squareIconSvg, squarePng);
renderSvg(roundedIconSvg, roundedPng);
renderSvg(foregroundSvg, foregroundPng);
renderSvg(androidRoundedIconSvg, androidRoundedPng);
renderSvg(androidForegroundSvg, androidForegroundPng);
flattenPng(squarePng);

writeFileSync(
  join(assetsDir, 'icon.svg'),
  `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
  <image width="1024" height="1024" href="./icon.png" />
</svg>
`,
);

const manifestPath = join(tmpDir, 'tauri-icon-manifest.json');
writeFileSync(
  manifestPath,
  JSON.stringify(
    {
      default: 'icon-rounded.png',
      bg_color: '#fffefd',
      android_fg: 'icon-foreground.png',
      android_fg_scale: 100,
    },
    null,
    2,
  ),
);

run('pnpm', ['exec', 'tauri', 'icon', manifestPath, '--output', 'apps/tauri/src-tauri/icons'], { stdio: 'inherit' });

const iosIconDir = join(repoRoot, 'apps', 'tauri', 'src-tauri', 'icons', 'ios');
const nativeIosIconDir = join(repoRoot, 'apps', 'ios', 'Assets.xcassets', 'AppIcon.appiconset');
const generatedAppleIconDir = join(repoRoot, 'apps', 'tauri', 'src-tauri', 'gen', 'apple', 'Assets.xcassets', 'AppIcon.appiconset');
const iosContentsPath = join(nativeIosIconDir, 'Contents.json');
generateIosIconSet(iosIconDir, squarePng, iosContentsPath, { writeContentsJson: false });
generateIosIconSet(nativeIosIconDir, squarePng, iosContentsPath);
generateIosIconSet(generatedAppleIconDir, squarePng, iosContentsPath);

const androidIconDir = join(repoRoot, 'apps', 'tauri', 'src-tauri', 'icons', 'android');
generateAndroidIcons(androidIconDir, androidRoundedPng, androidForegroundPng);
copyDirFiles(androidIconDir, join(repoRoot, 'apps', 'android', 'app', 'src', 'main', 'res'));
copyDirFiles(androidIconDir, join(repoRoot, 'apps', 'tauri', 'src-tauri', 'gen', 'android', 'app', 'src', 'main', 'res'));

const desktopSizes = new Map([
  ['32x32.png', 32],
  ['64x64.png', 64],
  ['128x128.png', 128],
  ['128x128@2x.png', 256],
  ['icon.png', 512],
  ['icon-1024-rgba8.png', 1024],
]);

for (const [file, size] of desktopSizes) {
  resizePng(roundedPng, join(repoRoot, 'apps', 'tauri', 'src-tauri', 'icons', file), size);
}

const windowsSizes = new Map([
  ['Square30x30Logo.png', 30],
  ['Square44x44Logo.png', 44],
  ['StoreLogo.png', 50],
  ['Square71x71Logo.png', 71],
  ['Square89x89Logo.png', 89],
  ['Square107x107Logo.png', 107],
  ['Square142x142Logo.png', 142],
  ['Square150x150Logo.png', 150],
  ['Square284x284Logo.png', 284],
  ['Square310x310Logo.png', 310],
]);

for (const [file, size] of windowsSizes) {
  resizePng(squarePng, join(repoRoot, 'apps', 'tauri', 'src-tauri', 'icons', file), size);
}

rmSync(tmpDir, { recursive: true, force: true });
