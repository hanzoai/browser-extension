#!/usr/bin/env node

const esbuild = require('esbuild');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

async function build() {
  console.log('Building browser extension...');

  // Ensure dist directories exist
  fs.mkdirSync('dist/browser-extension', { recursive: true });
  fs.mkdirSync('dist/browser-extension/chrome', { recursive: true });
  fs.mkdirSync('dist/browser-extension/firefox', { recursive: true });
  fs.mkdirSync('dist/browser-extension/safari', { recursive: true });

  // Build content script
  await esbuild.build({
    entryPoints: ['src/content-script.ts'],
    bundle: true,
    outfile: 'dist/browser-extension/content-script.js',
    platform: 'browser',
    target: ['chrome90', 'firefox91', 'safari14'],
    sourcemap: 'inline'
  });

  // Build background script for Chrome
  await esbuild.build({
    entryPoints: ['src/background.ts'],
    bundle: true,
    outfile: 'dist/browser-extension/background.js',
    platform: 'browser',
    target: ['chrome90', 'safari14'],
    format: 'esm',
    external: ['chrome', 'browser']
  });

  // Build Firefox-specific background script
  await esbuild.build({
    entryPoints: ['src/background-firefox.ts'],
    bundle: true,
    outfile: 'dist/browser-extension/background-firefox.js',
    platform: 'browser',
    target: ['firefox91'],
    format: 'iife',
    external: ['browser']
  });

  // Build WebGPU AI module
  await esbuild.build({
    entryPoints: ['src/webgpu-ai.ts'],
    bundle: true,
    outfile: 'dist/browser-extension/webgpu-ai.js',
    platform: 'browser',
    target: 'es2020',
    format: 'esm'
  });

  // Build sidebar (TS preferred, JS fallback)
  await esbuild.build({
    entryPoints: [fs.existsSync('src/sidebar.ts') ? 'src/sidebar.ts' : 'src/sidebar.js'],
    bundle: true,
    outfile: 'dist/browser-extension/sidebar.js',
    platform: 'browser',
    target: ['chrome90', 'firefox91', 'safari14'],
    sourcemap: 'inline',
  });

  // Build popup (TS preferred, JS fallback)
  await esbuild.build({
    entryPoints: [fs.existsSync('src/popup.ts') ? 'src/popup.ts' : 'src/popup.js'],
    bundle: true,
    outfile: 'dist/browser-extension/popup.js',
    platform: 'browser',
    target: ['chrome90', 'firefox91', 'safari14'],
    sourcemap: 'inline',
  });

  // Build browser control module
  await esbuild.build({
    entryPoints: ['src/browser-control.ts'],
    bundle: true,
    outfile: 'dist/browser-extension/browser-control.js',
    platform: 'browser',
    target: 'es2020',
    format: 'esm'
  });

  // Build CLI and server (for npm package)
  await esbuild.build({
    entryPoints: ['src/cli.ts'],
    bundle: true,
    outfile: 'dist/browser-extension/cli.js',
    platform: 'node',
    target: 'node16',
    packages: 'external'
  });

  // Build CDP Bridge Server
  await esbuild.build({
    entryPoints: ['src/cdp-bridge-server.ts'],
    bundle: true,
    outfile: 'dist/browser-extension/cdp-bridge-server.js',
    platform: 'node',
    target: 'node16',
    packages: 'external'
  });

  // Make CLI executable
  if (process.platform !== 'win32') {
    execSync('chmod +x dist/browser-extension/cli.js');
  }

  // Copy manifests
  fs.copyFileSync('src/manifest.json', 'dist/browser-extension/manifest.json');
  fs.copyFileSync('src/manifest.json', 'dist/browser-extension/chrome/manifest.json');
  fs.copyFileSync('src/manifest-firefox.json', 'dist/browser-extension/firefox/manifest.json');

  // Safari Info.plist
  fs.writeFileSync('dist/browser-extension/safari/Info.plist', `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleDisplayName</key>
    <string>Hanzo AI</string>
    <key>CFBundleIdentifier</key>
    <string>ai.hanzo.browser-extension</string>
    <key>CFBundleVersion</key>
    <string>1.7.2</string>
    <key>CFBundleShortVersionString</key>
    <string>1.7.2</string>
    <key>NSExtension</key>
    <dict>
        <key>NSExtensionPointIdentifier</key>
        <string>com.apple.Safari.web-extension</string>
        <key>NSExtensionPrincipalClass</key>
        <string>SafariWebExtensionHandler</string>
    </dict>
</dict>
</plist>`);

  // Static files to copy into each browser directory
  const staticFiles = ['popup.html', 'popup.css', 'sidebar.html', 'sidebar.css', 'callback.html', 'ai-worker.js'];
  const iconFiles = ['icon16.png', 'icon32.png', 'icon48.png', 'icon128.png'];

  // Copy common files to each browser directory
  ['chrome', 'firefox', 'safari'].forEach(browserName => {
    const dir = `dist/browser-extension/${browserName}`;

    fs.copyFileSync(
      'dist/browser-extension/content-script.js',
      `${dir}/content-script.js`
    );

    // Firefox uses IIFE background; Chrome/Safari use ESM
    if (browserName === 'firefox') {
      fs.copyFileSync('dist/browser-extension/background-firefox.js', `${dir}/background.js`);
    } else {
      fs.copyFileSync('dist/browser-extension/background.js', `${dir}/background.js`);
    }

    // Copy static HTML/CSS/JS
    for (const f of staticFiles) {
      const src = path.join('src', f);
      if (fs.existsSync(src)) {
        fs.copyFileSync(src, path.join(dir, f));
      }
    }

    // Copy compiled popup/sidebar scripts
    fs.copyFileSync('dist/browser-extension/popup.js', path.join(dir, 'popup.js'));
    fs.copyFileSync('dist/browser-extension/sidebar.js', path.join(dir, 'sidebar.js'));

    // Copy icons (check src/ first, then images/)
    for (const icon of iconFiles) {
      const srcIcon = path.join('src', icon);
      const imgIcon = path.join('images', icon);
      if (fs.existsSync(srcIcon)) {
        fs.copyFileSync(srcIcon, path.join(dir, icon));
      } else if (fs.existsSync(imgIcon)) {
        fs.copyFileSync(imgIcon, path.join(dir, icon));
      }
    }
  });

  // Copy package.json for npm
  const pkg = JSON.parse(fs.readFileSync('src/package.json', 'utf8'));
  pkg.main = 'cli.js';
  fs.writeFileSync(
    'dist/browser-extension/package.json',
    JSON.stringify(pkg, null, 2)
  );

  // Copy icons to root dist
  for (const icon of iconFiles) {
    const srcIcon = path.join('src', icon);
    const imgIcon = path.join('images', icon);
    if (fs.existsSync(srcIcon)) {
      fs.copyFileSync(srcIcon, path.join('dist/browser-extension', icon));
    } else if (fs.existsSync(imgIcon)) {
      fs.copyFileSync(imgIcon, path.join('dist/browser-extension', icon));
    }
  }

  // Generate Safari Xcode project if available
  try {
    execSync('xcrun --find safari-web-extension-converter', { stdio: 'ignore' });
    console.log('Generating Safari Xcode project...');
    execSync(
      `xcrun safari-web-extension-converter dist/browser-extension/chrome/ ` +
      `--project-location dist/safari ` +
      `--app-name "Hanzo AI" ` +
      `--bundle-identifier ai.hanzo.browser-extension ` +
      `--no-prompt --no-open --force`,
      { stdio: 'inherit' }
    );
    console.log('Safari: dist/safari/ (macOS + iOS Xcode project)');
  } catch {
    console.log('Safari: skipped (Xcode not available)');
  }

  console.log('Build complete!');
  console.log('  Chrome:  dist/browser-extension/chrome/');
  console.log('  Firefox: dist/browser-extension/firefox/');
  console.log('  NPM:     dist/browser-extension/');
}

build().catch(console.error);
