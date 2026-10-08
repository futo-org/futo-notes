/* The benchmark's note, shared by the in-page benchmark (bench.ts) and the
 * real-app runner (app-device.mjs), which loads it over CDP. */

/** The same mixed note the real-app runs used: headings, long paragraphs,
 * nested lists, code, quotes, tables, task lists, short tagged lines. */
export function generateNote(blocks) {
  const lorem =
    'The quick brown fox jumps over the lazy dog while the editor keeps every keystroke instant and every block in place. ';
  const out = [];
  for (let i = 0; i < blocks; i += 1) {
    switch (i % 8) {
      case 0:
        out.push(`## Section ${i}`);
        break;
      case 1:
        out.push(
          `${lorem.repeat(1 + (i % 5))}**bold ${i}** and _italic_ and \`code\` and [link](https://example.com/${i}).`,
        );
        break;
      case 2:
        out.push(`- item ${i} a\n- item ${i} b\n  - nested ${i}\n- item ${i} c`);
        break;
      case 3:
        out.push(
          '```js\n' +
            Array.from({ length: 6 }, (_, k) => `const v${k} = ${i} * ${k}; // line ${k}`).join(
              '\n',
            ) +
            '\n```',
        );
        break;
      case 4:
        out.push(`> Quote ${i}: ${lorem.repeat(2)}`);
        break;
      case 5:
        out.push(`| a | b | c |\n| --- | --- | --- |\n| ${i} | x | y |\n| z | ${i} | w |`);
        break;
      case 6:
        out.push(`- [ ] task ${i}\n- [x] done ${i}`);
        break;
      default:
        out.push(`Short line ${i} #tag${i % 20}`);
    }
  }
  return out.join('\n\n') + '\n';
}
