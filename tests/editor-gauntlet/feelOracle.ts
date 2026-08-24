import type { DriverState } from '../../factory/driver/protocol';
import type { EditorGauntletAdapter } from './types';

export const FEEL_ORACLE = {
  command: 'just factory-judge',
  passFailGate: false,
  artifact: 'factory/captures/last-run.json',
  visualCommand: 'just factory-up && just factory-visual',
} as const;

export interface FeelObservation {
  candidate: string;
  state: DriverState;
  oracle: typeof FEEL_ORACLE;
}

/**
 * Captures the candidate half using the same DriverState contract consumed by
 * the existing Obsidian judge. Human review, not this function, decides feel.
 */
export async function captureFeelObservation(
  adapter: EditorGauntletAdapter,
): Promise<FeelObservation> {
  return { candidate: adapter.name, state: await adapter.captureFeelState(), oracle: FEEL_ORACLE };
}
