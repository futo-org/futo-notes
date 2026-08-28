export type GauntletArtifactCapture = 'retain-on-failure' | 'off-retry-on-failure';

export function gauntletArtifactCapture(
  env: NodeJS.ProcessEnv = process.env,
): GauntletArtifactCapture {
  const configured = env.EDITOR_GAUNTLET_ARTIFACT_CAPTURE;
  if (configured === undefined || configured === '') return 'retain-on-failure';
  if (configured === 'off-retry-on-failure') return configured;
  throw new Error('EDITOR_GAUNTLET_ARTIFACT_CAPTURE must be off-retry-on-failure when configured');
}
