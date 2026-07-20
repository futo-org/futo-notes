export function warmEditorFonts(onready: () => void): void {
  const fonts = (document as unknown as { fonts?: FontFaceSet }).fonts;
  if (!fonts?.load) return;
  const specs = [
    ...['400', '500', '600', '700'].map((weight) => `${weight} 18px Barlow`),
    'italic 400 18px Barlow',
    'italic 700 18px Barlow',
  ];

  void Promise.allSettled(specs.map((spec) => fonts.load(spec))).then(onready);
}
