export interface ScrollBoundaryState {
  scrollTop: number;
  clientHeight: number;
  scrollHeight: number;
}

export function shouldPreventScrollChaining(state: ScrollBoundaryState, deltaY: number): boolean {
  const canScroll = state.scrollHeight > state.clientHeight + 1;
  if (!canScroll) return true;

  const atTop = state.scrollTop <= 0;
  const atBottom = state.scrollTop + state.clientHeight >= state.scrollHeight - 1;
  return (atTop && deltaY > 0) || (atBottom && deltaY < 0);
}
