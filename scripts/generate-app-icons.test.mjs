import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '..');
const read = (file) => readFileSync(resolve(root, file), 'utf8');
const choices = [
  'LightStandard',
  'LightReversed',
  'DarkStandard',
  'DarkReversed',
  'Futo',
  'Website',
];
const ids = [
  'light_standard',
  'light_reversed',
  'dark_standard',
  'dark_reversed',
  'futo',
  'website',
];

describe('packaged selectable mobile icons', () => {
  it('packages every iPhone, iPad and marketing icon and every picker preview', async () => {
    const project = read('apps/ios/project.yml');
    const mapping = read('apps/ios/Sources/Settings/AppIcon/AppIcon.swift');
    for (const name of choices) {
      expect(mapping).toContain(`"${name}"`);
      const catalog = name === 'LightStandard' ? 'AppIcon' : `AppIcon${name}`;
      if (name !== 'LightStandard') expect(project).toContain(catalog);
      const dir = `apps/ios/Assets.xcassets/${catalog}.appiconset`;
      const entries = JSON.parse(read(`${dir}/Contents.json`)).images;
      expect(new Set(entries.map((entry) => entry.idiom))).toEqual(
        new Set(['iphone', 'ipad', 'ios-marketing']),
      );
      for (const entry of entries) {
        const metadata = await sharp(resolve(root, dir, entry.filename)).metadata();
        const size = Number(entry.size.split('x')[0]) * Number(entry.scale.replace('x', ''));
        expect([metadata.width, metadata.height]).toEqual([size, size]);
        expect(metadata.hasAlpha).toBe(false);
      }
      const preview = `apps/ios/Assets.xcassets/AppIconPreview${name}.imageset`;
      expect(JSON.parse(read(`${preview}/Contents.json`)).images[0].filename).toBe('preview.png');
      expect((await sharp(resolve(root, preview, 'preview.png')).metadata()).width).toBe(256);
    }
  });
  it('preserves the shipped Android mark size and includes the Scanlines mole', async () => {
    const res = resolve(root, 'apps/android/app/src/main/res');
    async function bounds(file, visible) {
      const { data, info } = await sharp(resolve(res, file))
        .ensureAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });
      const xs = [],
        ys = [];
      for (let y = 0; y < info.height; y++)
        for (let x = 0; x < info.width; x++) {
          const i = (y * info.width + x) * 4;
          if (visible(data.subarray(i, i + 4))) {
            xs.push(x);
            ys.push(y);
          }
        }
      return xs.length
        ? [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]
        : null;
    }
    const original = await bounds(
      'mipmap-xxxhdpi/ic_launcher_foreground.png',
      ([r, g, b]) => r > 200 && g > 50 && g < 200 && b < 100,
    );
    const alternate = await bounds(
      'drawable-nodpi/app_icon_futo_foreground.png',
      ([, , , a]) => a > 250,
    );
    // The vector alternate and legacy raster differ by at most one antialiased pixel.
    for (let i = 0; i < 4; i++) expect(Math.abs(alternate[i] - original[i])).toBeLessThanOrEqual(1);
    expect(
      await bounds('drawable-nodpi/app_icon_website_foreground.png', ([, , , a]) => a > 0),
    ).not.toBeNull();
  });
  it('keeps MainActivity enabled and binds all six permanent launcher aliases to real assets', async () => {
    const manifest = read('apps/android/app/src/main/AndroidManifest.xml');
    const activity = manifest.match(/<activity\s[\s\S]*?<\/activity>/)[0];
    expect(activity).toContain('android:launchMode="singleTop"');
    expect(activity).toContain('android:scheme="futonotes"');
    expect(activity).not.toContain('android.intent.category.LAUNCHER');
    expect(activity).not.toContain('android:enabled="false"');
    const aliases = manifest.match(/<activity-alias\s[\s\S]*?<\/activity-alias>/g);
    expect(aliases).toHaveLength(6);
    const mapping = read(
      'apps/android/app/src/main/java/com/futo/notes/ui/settings/appicon/AppIcon.kt',
    );
    for (const [index, alias] of aliases.entries()) {
      expect(alias).toContain(`com.futo.notes.Launcher${choices[index]}`);
      expect(alias).toContain(`android:enabled="${index === 0}"`);
      expect(alias).toContain('android:targetActivity=".MainActivity"');
      expect(alias).toContain('android.intent.category.LAUNCHER');
      expect(mapping).toContain(`"${choices[index]}"`);
      const resource = index === 0 ? 'ic_launcher' : `app_icon_${ids[index]}`;
      expect(alias).toContain(`@mipmap/${resource}`);
      const adaptive = read(`apps/android/app/src/main/res/mipmap-anydpi-v26/${resource}.xml`);
      for (const match of adaptive.matchAll(/android:drawable="@(drawable|mipmap)\/([^"]+)"/g)) {
        const [_, type, name] = match;
        const candidates = type === 'drawable' ? ['drawable-nodpi'] : ['mipmap-xxxhdpi'];
        expect(
          candidates.some((dir) =>
            existsSync(resolve(root, `apps/android/app/src/main/res/${dir}/${name}.png`)),
          ),
        ).toBe(true);
      }
      expect(adaptive).toContain('<monochrome');
      const preview = await sharp(
        resolve(root, `apps/android/app/src/main/res/drawable-nodpi/app_icon_${ids[index]}.png`),
      ).metadata();
      expect([preview.width, preview.height]).toEqual([256, 256]);
    }
  });
});
