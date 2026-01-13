FUTO Notes is a simple, beautiful notes app that gets out of your way. It relies on markdown, but doesn't require knowledge of the syntax. FUTO Notes works entirely offline, but you have the option to sync to your other devices.

The goal is to build a tool that truly enhances your thinking and recall. By using advanced machine learning techniques, it is able to help you connect the dots, reference ideas from your past, and generate new ideas.

But at its foundation, it is a simple, rock-solid notes app.

To maximize interoperability, notes live in a folder as a series of .md files with no frontmatter. Sidecars are used to maintain information about these notes. Sync will be determined later, but will eventually be supported. In order to have robust offline support, Yjs/CRDT will be used for conflict resolution.

The title of the note is the name of the file minus `.md`. So `my grocery list.md` would be the file name and `my grocery list` would be the official title.

## Build & Run

### First-Time Setup

```bash
# Clone with submodules (recommended for fresh clone)
git clone --recurse-submodules https://github.com/your-repo/futo-notes.git

# OR if you already cloned without submodules:
git submodule update --init

# Install dependencies
npm install

# Clean up duplicate peer deps in the forked editor (required after npm install)
rm -rf react-native-live-markdown/node_modules/{react-native-reanimated,react-native-worklets,react,react-native}
```

### Development Commands

```bash
npx expo start                          # launches the Expo dev server
npx expo run:ios --device               # builds & runs on a connected iOS device/simulator
npx expo run:android                    # builds & runs on Android (debug)
npx expo run:android --variant release  # release build for perf testing
npm run lint                            # ESLint
```

Use `npx expo prebuild` when you need to customize native code or add manual native deps. Release/production issues should be verified with `npx expo run:android --variant release` (optimized build).

### Submodule: react-native-live-markdown

This project uses a forked version of `@expensify/react-native-live-markdown` as a git submodule. The fork lives in the `react-native-live-markdown/` directory and is linked via `file:./react-native-live-markdown` in package.json.

**To update the submodule to latest:**
```bash
cd react-native-live-markdown
git pull origin main
cd ..
git add react-native-live-markdown
git commit -m "Update react-native-live-markdown submodule"
```

**To modify the forked editor:**
1. Edit files in `react-native-live-markdown/src/`
2. Run `npm run prepare` inside the submodule directory
3. Metro will pick up changes automatically

**Troubleshooting:**
- If you see duplicate React errors, run the cleanup command: `rm -rf react-native-live-markdown/node_modules/{react-native-reanimated,react-native-worklets,react,react-native}`
- If submodule is empty after clone, run: `git submodule update --init`
