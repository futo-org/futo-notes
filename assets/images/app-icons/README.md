# Selectable mobile app icons

Regenerate platform catalogs, adaptive layers, and picker previews with `just app-icons`.
The generator uses the pinned `sharp` dev dependency and only checked-in sources.
The existing `assets/images/icon.png`, primary iOS catalog, and Android primary
foreground/background retain their original artwork and geometry.

The four SVGs are original vector assets downloaded on 2026-10-02 from the
[FUTO Notes branding file](https://www.figma.com/design/aRkXaG6PNHotvdR1fnZ4xW/FUTO-Notes---Branding):

| Source               | Figma node |
| -------------------- | ---------- |
| `light-reversed.svg` | `328:581`  |
| `dark-standard.svg`  | `329:972`  |
| `dark-reversed.svg`  | `329:974`  |
| `futo.svg`           | `335:6`    |

Dark / Reversed includes 32px export overflow; generation crops to the original
1024px tile without the outside shadow. Internal gradients and effects remain.

`website-logo.svg` is copied from `futo.tech/src/assets/logos/logo-futonotes.svg`.
`website.png` is the isolated ProjectCard tile captured using Chromium at 64 CSS
pixels and 16× device scale: neutral-blue-800 (`rgb(17,33,43)`) background,
1px neutral-blue-200 (`rgb(207,234,255)`) border at 10%, the colored logo filling
the inside, and a white 2px / transparent 4px scanline overlay at 9% opacity
with overlay blending. There is no outside glow or outer rounded-square mask.
The source of this composition is ProjectCard in `src/routes/projects/index.tsx`
and `.scanlines-sm` in `src/styles/styles.css` in the sibling website project;
regeneration never accesses that checkout.

Android themed icons use the same monochrome mole for every choice, so system
tinting deliberately suppresses differences in color and texture.
