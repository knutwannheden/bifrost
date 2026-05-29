import type { ForgeConfig } from '@electron-forge/shared-types';
import { MakerSquirrel } from '@electron-forge/maker-squirrel';
import { MakerZIP } from '@electron-forge/maker-zip';
import { MakerDeb } from '@electron-forge/maker-deb';
import { MakerRpm } from '@electron-forge/maker-rpm';
import { VitePlugin } from '@electron-forge/plugin-vite';
import { FusesPlugin } from '@electron-forge/plugin-fuses';
import { FuseV1Options, FuseVersion } from '@electron/fuses';
import { execSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';

const config: ForgeConfig = {
  packagerConfig: {
    asar: {
      unpack: '**/{node-pty,node-pty/**,better-sqlite3,better-sqlite3/**,@parcel,@parcel/**}',
    },
    icon: './assets/icon',
    name: 'Bifrost',
    executableName: 'Bifrost',
  },
  hooks: {
    // Patch the stock Electron.app bundle during development so the macOS dock
    // and app-switcher display "Bifrost" (with our icon) instead of "Electron".
    preStart: async () => {
      if (process.platform !== 'darwin') return;
      const electronApp = path.join(
        __dirname, 'node_modules', 'electron', 'dist', 'Electron.app',
      );
      const plistPath = path.join(electronApp, 'Contents', 'Info.plist');
      if (!fs.existsSync(plistPath)) return;
      try {
        execSync(`/usr/libexec/PlistBuddy -c "Set :CFBundleDisplayName Bifrost" "${plistPath}"`);
        execSync(`/usr/libexec/PlistBuddy -c "Set :CFBundleName Bifrost" "${plistPath}"`);
      } catch {
        // Fields may not exist yet — try Add instead
        try {
          execSync(`/usr/libexec/PlistBuddy -c "Add :CFBundleDisplayName string Bifrost" "${plistPath}"`);
        } catch { /* already set */ }
        try {
          execSync(`/usr/libexec/PlistBuddy -c "Add :CFBundleName string Bifrost" "${plistPath}"`);
        } catch { /* already set */ }
      }
      // Copy our icon into the Electron bundle so the dock shows it
      const src = path.join(__dirname, 'assets', 'icon.icns');
      const dest = path.join(electronApp, 'Contents', 'Resources', 'electron.icns');
      if (fs.existsSync(src)) {
        fs.copyFileSync(src, dest);
      }
    },
    // Copy native modules and plugin source into the packaged app
    packageAfterCopy: async (_config, buildPath) => {
      const nativeModules = ['node-pty', 'nan', 'node-addon-api', 'better-sqlite3', 'bindings', 'file-uri-to-path', '@parcel/watcher'];
      // @parcel/watcher resolves its prebuilt binary from a platform-specific
      // package (e.g. @parcel/watcher-darwin-arm64); copy whichever ones the
      // build host installed.
      const parcelDir = path.join(__dirname, 'node_modules', '@parcel');
      if (fs.existsSync(parcelDir)) {
        for (const entry of fs.readdirSync(parcelDir)) {
          if (entry.startsWith('watcher-')) nativeModules.push(`@parcel/${entry}`);
        }
      }
      for (const mod of nativeModules) {
        const src = path.join(__dirname, 'node_modules', mod);
        const dest = path.join(buildPath, 'node_modules', mod);
        if (fs.existsSync(src)) {
          fs.cpSync(src, dest, { recursive: true });
        }
      }

      // Copy the Claude Code plugin source so it can be deployed at runtime
      const pluginSrc = path.join(__dirname, 'src', 'claude-plugin');
      const pluginDest = path.join(buildPath, 'claude-plugin');
      if (fs.existsSync(pluginSrc)) {
        fs.cpSync(pluginSrc, pluginDest, { recursive: true });
      }
    },
  },
  rebuildConfig: {
    // node-pty ships with prebuilds for all platforms — skip rebuilding to
    // avoid creating a build/Release that shadows the prebuilds directory
    // and can break when spawn-helper goes missing.
    // @parcel/watcher is N-API based, so its prebuilt binary loads under
    // Electron unchanged — skip the rebuild and use the prebuild.
    ignoreModules: ['node-pty', '@parcel/watcher'],
  },
  makers: [
    new MakerSquirrel({}),
    new MakerZIP({}, ['darwin']),
    new MakerRpm({}),
    new MakerDeb({}),
  ],
  plugins: [
    new VitePlugin({
      build: [
        {
          entry: 'src/main/main.ts',
          config: 'vite.main.config.ts',
          target: 'main',
        },
        {
          entry: 'src/preload/preload.ts',
          config: 'vite.preload.config.ts',
          target: 'preload',
        },
      ],
      renderer: [
        {
          name: 'main_window',
          config: 'vite.renderer.config.mts',
        },
      ],
    }),
    new FusesPlugin({
      version: FuseVersion.V1,
      [FuseV1Options.RunAsNode]: false,
      [FuseV1Options.EnableCookieEncryption]: true,
      [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
      [FuseV1Options.EnableNodeCliInspectArguments]: false,
      [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
      [FuseV1Options.OnlyLoadAppFromAsar]: true,
    }),
  ],
};

export default config;
