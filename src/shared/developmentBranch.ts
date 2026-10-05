/** The git branch `just tauri-dev` runs (scripts/tauri-dev.mjs), so parallel dev instances are distinguishable. */
export const developmentBranch: string | undefined = import.meta.env.DEV
  ? import.meta.env.VITE_DEV_BRANCH || undefined
  : undefined;
