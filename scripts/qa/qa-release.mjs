export function parseReleaseArgs(args) {
  const flags = args.filter((arg) => arg.startsWith('--'));
  const unknownFlags = flags.filter((arg) => arg !== '--shutdown');
  if (unknownFlags.length) throw new Error(`unknown release option ${unknownFlags[0]}`);
  const positional = args.filter((arg) => !arg.startsWith('--'));
  if (positional.length > 1)
    throw new Error('release accepts at most one platform: ios or android');
  const platform = positional[0];
  if (platform && platform !== 'ios' && platform !== 'android') {
    throw new Error(`unknown release platform ${platform}; use ios or android`);
  }
  return { platform, shutdown: args.includes('--shutdown') };
}

export function devicesForRelease(devices, platform) {
  return platform ? devices.filter((device) => device.platform === platform) : devices;
}
