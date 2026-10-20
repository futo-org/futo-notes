// Seeding helpers and generated-file targets shared by the gate red-proofs
// (scripts/gate-redproofs.mjs).
import fs from 'node:fs';
import path from 'node:path';

// Generated-contract targets, for the three gen-*-spec proofs.
export const TOOLBAR_SWIFT = 'apps/ios/Sources/Editor/GeneratedContracts/ToolbarSpec.swift';
export const TOOLBAR_KOTLIN = 'apps/android/app/src/main/java/com/futo/notes/ui/ToolbarSpec.kt';
export const TITLE_SWIFT = 'apps/ios/Sources/Editor/GeneratedContracts/TitleSpec.swift';
export const TITLE_KOTLIN = 'apps/android/app/src/main/java/com/futo/notes/ui/TitleSpec.kt';
export const BRIDGE_SWIFT = 'apps/ios/Sources/Editor/GeneratedContracts/BridgeSpec.swift';
export const BRIDGE_KOTLIN = 'apps/android/app/src/main/java/com/futo/notes/ui/BridgeSpec.kt';

// ---------------------------------------------------------------------------
// Seeding helpers — every mutation goes through these so revert stays simple
// ---------------------------------------------------------------------------

export const seed = {
  write(wt, rel, content) {
    const abs = path.join(wt, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  },
  append(wt, rel, content) {
    fs.appendFileSync(path.join(wt, rel), content);
  },
  replace(wt, rel, from, to) {
    const abs = path.join(wt, rel);
    const text = fs.readFileSync(abs, 'utf8');
    if (!text.includes(from)) {
      throw new Error(`seed.replace: ${rel} no longer contains ${JSON.stringify(from)}`);
    }
    fs.writeFileSync(abs, text.replace(from, to));
  },
  json(wt, rel, mutate) {
    const abs = path.join(wt, rel);
    const data = JSON.parse(fs.readFileSync(abs, 'utf8'));
    mutate(data);
    fs.writeFileSync(abs, `${JSON.stringify(data, null, 2)}\n`);
  },
  read(wt, rel) {
    return fs.readFileSync(path.join(wt, rel), 'utf8');
  },
  readJson(wt, rel) {
    return JSON.parse(fs.readFileSync(path.join(wt, rel), 'utf8'));
  },
};

export const SENTINEL_HEADER =
  '// Seeded by scripts/gate-redproofs.mjs inside a throwaway git worktree. If you are\n' +
  '// reading this in a real checkout, a proof failed to revert — delete the file.\n';
