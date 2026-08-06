/**
 * Reads the Compose UI as labelled tap targets from a uiautomator dump.
 *
 * Anchoring on a node's own text is what keeps a layout change from silently
 * tapping the wrong control, which coordinates copied from a screenshot cannot
 * (AGENTS.md M21). Parsing is pure and separate from the dump so it can be tested
 * against captured XML without a device.
 */

/** Attributes on one opening `<node>` tag. Nodes with children do not self-close,
 *  so only the tag's own attributes are matched. */
const NODE_PATTERN = /<node\b([^>]*?)\/?>/g;
const ATTRIBUTE_PATTERN = /([\w-]+)="([^"]*)"/g;
const BOUNDS_PATTERN = /^\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]$/;

const XML_ENTITIES = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
};

/**
 * uiautomator XML-escapes attribute values, so a label containing `&` or a quote
 * arrives encoded and would never match what the caller asked for.
 */
export function decodeXmlEntities(value) {
  return value.replace(/&(#x?[0-9a-fA-F]+|\w+);/g, (whole, entity) => {
    if (entity.startsWith('#x') || entity.startsWith('#X')) {
      return String.fromCodePoint(Number.parseInt(entity.slice(2), 16));
    }
    if (entity.startsWith('#')) return String.fromCodePoint(Number.parseInt(entity.slice(1), 10));
    return XML_ENTITIES[entity] ?? whole;
  });
}

/**
 * Every labelled node in a dump, with the centre point to tap.
 *
 * A node carrying both `text` and a different `content-desc` yields one entry per
 * label, because either is a reasonable thing for a caller to name.
 */
export function parseUiNodes(xml) {
  const nodes = [];
  for (const [, rawAttributes] of xml.matchAll(NODE_PATTERN)) {
    const attributes = {};
    for (const [, name, value] of rawAttributes.matchAll(ATTRIBUTE_PATTERN)) {
      attributes[name] = decodeXmlEntities(value);
    }
    const bounds = parseBounds(attributes.bounds);
    if (!bounds) continue;

    const labels = [
      ['text', attributes.text],
      ['content-desc', attributes['content-desc']],
    ].filter(([, label]) => label);
    for (const [kind, label] of labels) {
      if (kind === 'content-desc' && label === attributes.text) continue;
      nodes.push({
        label,
        kind,
        bounds,
        x: Math.round((bounds.left + bounds.right) / 2),
        y: Math.round((bounds.top + bounds.bottom) / 2),
        resourceId: attributes['resource-id'] || null,
        clickable: attributes.clickable === 'true',
        enabled: attributes.enabled !== 'false',
      });
    }
  }
  return nodes;
}

function parseBounds(raw) {
  const match = raw?.match(BOUNDS_PATTERN);
  if (!match) return null;
  const [, left, top, right, bottom] = match.map(Number);
  // A zero-area node has no tappable centre — Compose emits these for
  // measured-but-unplaced content.
  if (right <= left || bottom <= top) return null;
  return { left, top, right, bottom };
}

/** Labels currently on screen, for an error message that says what WAS there. */
export const describeUiNodes = (nodes) => nodes.map((node) => node.label).join(' | ');
