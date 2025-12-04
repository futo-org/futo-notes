FUTO Notes is a simple, beautiful notes app that gets out of your way. It relies on markdown, but doesn't require knowledge of the syntax. FUTO Notes works entirely offline, but you have the option to sync to your other devices.

The goal is to build a tool that truly enhances your thinking and recall. By using advanced machine learning techniques, it is able to help you connect the dots, reference ideas from your past, and generate new ideas.

But at its foundation, it is a simple, rock-solid notes app. It is built on React Native and uses [Cactus](https://github.com/cactus-compute/cactus-react-native) for ML features.

To maximize interoperability, notes live in a folder as a series of .md files with no frontmatter. Sidecars are used to maintain information about these notes. We'll use [Cactus](https://github.com/cactus-compute/cactus-react-native) to do embeddings. Sync will be determined later, but will eventually be supported. In order to have robust offline support, Yjs/CRDT will be used for conflict resolution.

The title of the note is the name of the file minus `.md`. So `my grocery list.md` would be the file name and `my grocery list` would be the official title.
