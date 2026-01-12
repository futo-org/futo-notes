const { getDefaultConfig } = require('expo/metro-config');
const path = require('path');

const config = getDefaultConfig(__dirname);

// Handle the symlinked react-native-live-markdown package
const liveMarkdownPath = path.resolve(__dirname, 'react-native-live-markdown');

config.watchFolders = [liveMarkdownPath];

config.resolver.nodeModulesPaths = [
  path.resolve(__dirname, 'node_modules'),
  path.resolve(liveMarkdownPath, 'node_modules'),
];

// Ensure the symlinked package can resolve its peer dependencies from the main app
config.resolver.extraNodeModules = {
  'react': path.resolve(__dirname, 'node_modules/react'),
  'react-native': path.resolve(__dirname, 'node_modules/react-native'),
  'react-native-reanimated': path.resolve(__dirname, 'node_modules/react-native-reanimated'),
  'react-native-worklets': path.resolve(__dirname, 'node_modules/react-native-worklets'),
};

module.exports = config;
