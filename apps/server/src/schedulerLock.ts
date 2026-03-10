type LockHolder = 'search' | 'plugins';
let current: LockHolder | null = null;

export function tryAcquire(who: LockHolder): boolean {
  if (current !== null) return false;
  current = who;
  return true;
}

export function release(who: LockHolder): void {
  if (current === who) current = null;
}

export function holder(): LockHolder | null {
  return current;
}
