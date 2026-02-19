const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 } as const;
type Level = keyof typeof LEVELS;

const level: Level = (process.env.LOG_LEVEL as Level) || 'info';
const threshold = LEVELS[level] ?? LEVELS.info;

const DIM = '\x1b[2m';
const YELLOW = '\x1b[33m';
const RED = '\x1b[31m';
const RESET = '\x1b[0m';

function timestamp(): string {
  return new Date().toLocaleTimeString('en-GB', { hour12: false });
}

function emit(lvl: Level, color: string, msg: string): void {
  if (LEVELS[lvl] < threshold) return;
  const tag = lvl.toUpperCase().padEnd(5);
  console.log(`${color}${timestamp()} ${tag}${RESET} ${msg}`);
}

export const log = {
  debug: (msg: string) => emit('debug', DIM, msg),
  info: (msg: string) => emit('info', '', msg),
  warn: (msg: string) => emit('warn', YELLOW, msg),
  error: (msg: string) => emit('error', RED, msg),
};
