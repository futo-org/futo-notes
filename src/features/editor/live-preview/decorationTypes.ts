import type { WidgetType } from '@codemirror/view';

export interface PendingDecorationValue {
  class?: string;
  attributes?: Record<string, string>;
  replace?: boolean;
  wrapInsideMark?: boolean;
  widget?: WidgetType;
  side?: number;
  startSide?: number;
  endSide?: number;
}

export interface PendingDecoration {
  from: number;
  to: number;
  value: PendingDecorationValue;
}
