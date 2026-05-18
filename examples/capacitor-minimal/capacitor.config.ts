import type { CapacitorConfig } from '@capacitor/cli'

// Capacitor configuration for the minimal Cofferdam example.
//
// `webDir` points at Vite's default build output. Run `yarn build` first,
// then `yarn cap:sync` to copy the web bundle into the native iOS / Android
// projects. Run `yarn cap:add:ios` / `yarn cap:add:android` once to scaffold
// those projects (creates `ios/` and `android/` folders that should be
// committed by the consumer app, but are gitignored in this example).
const config: CapacitorConfig = {
  appId: 'com.cofferdam.example.minimal',
  appName: 'Cofferdam Minimal',
  webDir: 'dist',
  server: {
    androidScheme: 'https',
  },
}

export default config
