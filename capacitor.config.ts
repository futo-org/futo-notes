import { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.futo.notes',
  appName: 'FUTO Notes',
  webDir: 'dist',
  server: {
    androidScheme: 'https'
  },
  android: {
    useSafeArea: true
  },
  ios: {
    contentInset: 'never',
    scrollEnabled: false
  },
  plugins: {
    Keyboard: {
      resize: 'none',
      resizeOnFullScreen: false
    }
  }
};

export default config;
