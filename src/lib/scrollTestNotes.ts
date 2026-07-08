/** Scroll test notes — one per element type, each with enough content to scroll substantially. */

function repeat(n: number, fn: (i: number) => string): string {
  return Array.from({ length: n }, (_, i) => fn(i + 1)).join('\n');
}

export const SCROLL_TEST_NOTES: Array<{ title: string; content: string }> = [
  {
    title: 'Scroll Test Headings',
    content:
      '# Scroll Test Headings\n\n' +
      repeat(200, (i) => {
        const level = ((i - 1) % 6) + 1;
        return `${'#'.repeat(level)} Heading ${i} level ${level}\n\nSome text after heading ${i}.\n`;
      }),
  },
  {
    title: 'Scroll Test Paragraphs',
    content:
      '# Scroll Test Paragraphs\n\n' +
      repeat(
        200,
        (i) =>
          `This is paragraph number ${i}. Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat. Duis aute irure dolor in reprehenderit in voluptate velit esse cillum dolore eu fugiat nulla pariatur.\n`,
      ),
  },
  {
    title: 'Scroll Test Bold',
    content:
      '# Scroll Test Bold\n\n' +
      repeat(
        200,
        (i) =>
          `**This is bold line number ${i} with some extra text to fill the line out a bit more.**\n`,
      ),
  },
  {
    title: 'Scroll Test Italic',
    content:
      '# Scroll Test Italic\n\n' +
      repeat(
        200,
        (i) =>
          `*This is italic line number ${i} with some extra text to fill the line out a bit more.*\n`,
      ),
  },
  {
    title: 'Scroll Test Strikethrough',
    content:
      '# Scroll Test Strikethrough\n\n' +
      repeat(
        200,
        (i) =>
          `~~This is strikethrough line number ${i} with some extra words to make it longer.~~\n`,
      ),
  },
  {
    title: 'Scroll Test Inline Code',
    content:
      '# Scroll Test Inline Code\n\n' +
      repeat(
        200,
        (i) => `Here is some \`inline code number ${i}\` in a sentence with more text around it.\n`,
      ),
  },
  {
    title: 'Scroll Test Code Blocks',
    content:
      '# Scroll Test Code Blocks\n\n' +
      repeat(
        100,
        (i) =>
          `\`\`\`javascript\n// Code block ${i}\nfunction example${i}() {\n  const x = ${i};\n  return x * 2;\n}\n\`\`\`\n`,
      ),
  },
  {
    title: 'Scroll Test Block Quotes',
    content:
      '# Scroll Test Block Quotes\n\n' +
      repeat(150, (i) => {
        let s = `> This is block quote number ${i}. It contains enough text to make it meaningful for scroll testing purposes.\n`;
        if (i % 3 === 0) s += `> > This is a nested quote inside block ${i}.\n`;
        return s;
      }),
  },
  {
    title: 'Scroll Test Unordered Lists',
    content:
      '# Scroll Test Unordered Lists\n\n' +
      repeat(200, (i) => {
        let s = `- List item number ${i} with enough text to be visible`;
        if (i % 5 === 0) s += `\n  - Nested item under ${i}\n  - Another nested item under ${i}`;
        return s;
      }),
  },
  {
    title: 'Scroll Test Ordered Lists',
    content:
      '# Scroll Test Ordered Lists\n\n' +
      repeat(200, (i) => {
        let s = `${i}. Ordered list item number ${i} with enough text`;
        if (i % 5 === 0)
          s += `\n   1. Nested ordered item under ${i}\n   2. Another nested ordered item under ${i}`;
        return s;
      }),
  },
  {
    title: 'Scroll Test Task Lists',
    content:
      '# Scroll Test Task Lists\n\n' +
      repeat(200, (i) => {
        const checked = i % 3 === 0 ? 'x' : ' ';
        return `- [${checked}] Task item number ${i} that needs to be done or is done`;
      }),
  },
  {
    title: 'Scroll Test Links',
    content:
      '# Scroll Test Links\n\n' +
      repeat(
        200,
        (i) =>
          `Here is [link number ${i}](https://example.com/${i}) in a sentence with surrounding text.\n`,
      ),
  },
  {
    title: 'Scroll Test Horizontal Rules',
    content:
      '# Scroll Test Horizontal Rules\n\n' +
      repeat(150, (i) => `Section ${i} content here.\n\n---\n`),
  },
  {
    title: 'Scroll Test Tables',
    content:
      '# Scroll Test Tables\n\n' +
      repeat(
        50,
        (i) =>
          `| Column A | Column B | Column C |\n|----------|----------|----------|\n` +
          Array.from(
            { length: 5 },
            (_, j) => `| Row ${j + 1} A${i} | Row ${j + 1} B${i} | Row ${j + 1} C${i} |`,
          ).join('\n') +
          '\n',
      ),
  },
  {
    title: 'Scroll Test Images',
    content:
      '# Scroll Test Images\n\n' +
      repeat(
        50,
        (i) =>
          `Image ${i} below:\n\n![Test image ${i}](https://futo.org/images/authors/futologo.png)\n`,
      ),
  },
  {
    title: 'Scroll Test Mixed Emphasis',
    content:
      '# Scroll Test Mixed Emphasis\n\n' +
      repeat(200, (i) => {
        if (i % 4 === 0) return `***Bold and italic line ${i} with enough text to see it.***\n`;
        if (i % 4 === 1) return `**Bold with *nested italic* in line ${i} for testing.**\n`;
        if (i % 4 === 2) return `*Italic with **nested bold** in line ${i} for testing.*\n`;
        return `Normal text then **bold** then *italic* then ~~strikethrough~~ in line ${i}.\n`;
      }),
  },
];
