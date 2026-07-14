export function isHeadingNode(nodeName: string): boolean {
  return /^ATXHeading[1-6]$/.test(nodeName);
}

export function getHeadingLevel(nodeName: string): number {
  const match = nodeName.match(/ATXHeading(\d)/);
  return match ? Number.parseInt(match[1], 10) : 0;
}

export function isEmphasisNode(nodeName: string): boolean {
  return nodeName === 'Emphasis' || nodeName === 'StrongEmphasis';
}

export function isCodeNode(nodeName: string): boolean {
  return nodeName === 'InlineCode' || nodeName === 'CodeBlock' || nodeName === 'FencedCode';
}

export function isLinkNode(nodeName: string): boolean {
  return nodeName === 'Link';
}

export function isImageNode(nodeName: string): boolean {
  return nodeName === 'Image';
}

export function isListItemNode(nodeName: string): boolean {
  return nodeName === 'ListItem';
}

export function isBlockQuoteNode(nodeName: string): boolean {
  return nodeName === 'Blockquote';
}

export function isStrikethroughNode(nodeName: string): boolean {
  return nodeName === 'Strikethrough';
}

export function isHorizontalRuleNode(nodeName: string): boolean {
  return nodeName === 'HorizontalRule';
}
