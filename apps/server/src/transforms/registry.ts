import type { SmartTransform } from './types.js';
import { untitledNoMore } from './untitledNoMore.js';

const TRANSFORMS: SmartTransform[] = [untitledNoMore];

export function getAllTransforms(): SmartTransform[] {
  return TRANSFORMS;
}

export function getTransform(id: string): SmartTransform | undefined {
  return TRANSFORMS.find((t) => t.id === id);
}
