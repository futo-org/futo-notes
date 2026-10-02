/** Generate only the selectable mobile icon assets from checked-in artwork.
 * Run through `just app-icons`. The primary launcher artwork stays unchanged.
 * Requires sharp (the pinned dev dependency); no Figma/sibling checkout/network.
 */
import sharp from 'sharp';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const source = path.join(root, 'assets/images/app-icons');
const ios = path.join(root, 'apps/ios/Assets.xcassets');
const android = path.join(root, 'apps/android/app/src/main/res');
const choices = [
  ['light-standard', 'LightStandard'],
  ['light-reversed', 'LightReversed'],
  ['dark-standard', 'DarkStandard'],
  ['dark-reversed', 'DarkReversed'],
  ['futo', 'Futo'],
  ['website', 'Website'],
];
async function save(file, data) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, data);
}
const json = (value) => JSON.stringify(value, null, 2) + '\n';
for (const [id, name] of choices) {
  let artwork;
  if (id === 'light-standard') {
    artwork = await readFile(path.join(root, 'assets/images/icon.png'));
  } else if (id === 'website') {
    artwork = await readFile(path.join(source, 'website.png'));
  } else {
    // Dark/Reversed's export includes 32px of outside shadow. The launcher
    // tile is its original 1024px rect; discard only that export overflow.
    let svg = await readFile(path.join(source, `${id}.svg`), 'utf8');
    if (id === 'dark-reversed') {
      svg = svg
        .replace('viewBox="0 0 1088 1088"', 'viewBox="32 32 1024 1024"')
        .replace('width="1088" height="1088"', 'width="1024" height="1024"');
    }
    artwork = await sharp(Buffer.from(svg)).resize(1024, 1024).flatten().png().toBuffer();
  }
  const preview = await sharp(artwork).resize(256, 256).removeAlpha().png().toBuffer();
  await save(path.join(ios, `AppIconPreview${name}.imageset/preview.png`), preview);
  await save(
    path.join(ios, `AppIconPreview${name}.imageset/Contents.json`),
    json({
      images: [{ idiom: 'universal', filename: 'preview.png' }],
      info: { version: 1, author: 'xcode' },
    }),
  );
  await save(path.join(android, `drawable-nodpi/app_icon_${id.replaceAll('-', '_')}.png`), preview);
  if (id === 'light-standard') continue;
  const catalog = JSON.parse(
    await readFile(path.join(ios, 'AppIcon.appiconset/Contents.json'), 'utf8'),
  );
  for (const entry of catalog.images) {
    if (!entry.filename) continue;
    const [points] = entry.size.split('x');
    const size = Math.round(Number(points) * Number(entry.scale.replace('x', '')));
    await save(
      path.join(ios, `AppIcon${name}.appiconset`, entry.filename),
      await sharp(artwork).resize(size, size).removeAlpha().png().toBuffer(),
    );
  }
  await save(path.join(ios, `AppIcon${name}.appiconset/Contents.json`), json(catalog));
  const resource = `app_icon_${id.replaceAll('-', '_')}`;
  // Background is the full tile; a smaller transparent mark fits the adaptive
  // safe region. Scanlines uses only its textured background.
  let foreground, background;
  {
    const svg = await readFile(
      path.join(source, id === 'website' ? 'website-logo.svg' : `${id}.svg`),
      'utf8',
    );
    const rect = svg.match(/<rect\b[^>]*\/>/)[0];
    const defs = svg.match(/<defs>[\s\S]*<\/defs>/)?.[0] ?? '';
    const box = id === 'dark-reversed' ? '32 32 1024 1024' : '0 0 1024 1024';
    const bgSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="432" height="432" viewBox="${box}">${rect}${defs}</svg>`;
    background = await sharp(Buffer.from(bgSvg)).png().toBuffer();
    let mark = svg.replace(rect, '');
    if (id === 'dark-reversed')
      mark = mark.replace('viewBox="0 0 1088 1088"', 'viewBox="32 32 1024 1024"');
    // Match the shipped primary foreground: a 228 × 208px mark in a 432px layer.
    foreground = await sharp(Buffer.from(mark))
      .resize(312, 312)
      .extend({ top: 60, bottom: 60, left: 60, right: 60, background: '#00000000' })
      .png()
      .toBuffer();
    if (id === 'website') {
      // 2px / 6px at a 64px tile, normalized to the 72dp launcher viewport
      // inside the 108dp adaptive layers (4 pixels per dp).
      const stripes = Buffer.from(
        `<svg xmlns="http://www.w3.org/2000/svg" width="432" height="432"><defs><pattern id="s" width="27" height="27" patternUnits="userSpaceOnUse"><rect width="27" height="9" fill="white" fill-opacity=".09"/></pattern></defs><rect width="432" height="432" fill="url(#s)"/></svg>`,
      );
      // Scanlines has no mole; keep the foreground fully transparent.
      foreground = await sharp({
        create: { width: 432, height: 432, channels: 4, background: '#00000000' },
      })
        .png()
        .toBuffer();
      background = await sharp(background)
        .ensureAlpha()
        .composite([{ input: stripes, blend: 'overlay' }])
        .png()
        .toBuffer();
    }
  }
  await save(path.join(android, `drawable-nodpi/${resource}_foreground.png`), foreground);
  await save(path.join(android, `drawable-nodpi/${resource}_background.png`), background);
  await save(
    path.join(android, `mipmap-anydpi-v26/${resource}.xml`),
    `<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">\n  <background android:drawable="@drawable/${resource}_background"/>\n  <foreground android:drawable="@drawable/${resource}_foreground"/>\n  <monochrome android:drawable="@drawable/app_icon_monochrome"/>\n</adaptive-icon>\n`,
  );
}
// The monochrome mark is shared: themed icons deliberately discard color/texture.
const svg = await readFile(path.join(source, 'futo.svg'), 'utf8');
const mark = svg.replace(/<rect\b[^>]*\/>/, '');
await save(
  path.join(android, 'drawable-nodpi/app_icon_monochrome.png'),
  await sharp(Buffer.from(mark))
    .resize(312, 312)
    .extend({ top: 60, bottom: 60, left: 60, right: 60, background: '#00000000' })
    .png()
    .toBuffer(),
);
console.log('Generated six previews, five alternate catalogs and adaptive icons.');
