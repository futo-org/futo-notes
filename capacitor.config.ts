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
    contentInset: 'always'
  },
  plugins: {
    CapacitorSQLite: {
      iosDatabaseLocation: 'Library/CapacitorDatabase',
      iosIsEncryption: false,
      androidIsEncryption: false
    }
  }
};

export default config;
