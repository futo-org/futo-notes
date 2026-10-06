// The user-agent platform flags, alone so the editor bundle can read them
// without importing the rest of the platform layer.
export const isLinux = typeof navigator !== 'undefined' && /\blinux\b/i.test(navigator.userAgent);
