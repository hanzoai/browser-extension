#!/usr/bin/env node

import { Command } from 'commander';
import { BrowserExtensionServer } from './browser-extension-server';
import chalk from 'chalk';
import * as fs from 'fs';
import * as path from 'path';
import { spawn } from 'child_process';

const program = new Command();

program
  .name('hanzo-browser-server')
  .description('Start the Hanzo browser extension server for click-to-code navigation')
  .version('1.0.0');

program
  .command('start')
  .description('Start the browser extension WebSocket server')
  .option('-p, --port <port>', 'Port to run the server on', '3001')
  .option('-r, --root <path>', 'Project root directory', process.cwd())
  .option('--install-extension', 'Build and show instructions for installing the browser extension')
  .action(async (options) => {
    const port = parseInt(options.port);
    const projectRoot = path.resolve(options.root);

    console.log(chalk.blue('🚀 Starting Hanzo Browser Extension Server'));
    console.log(chalk.gray(`   Port: ${port}`));
    console.log(chalk.gray(`   Project root: ${projectRoot}`));

    // Start the server
    const server = new BrowserExtensionServer(port, projectRoot);

    server.on('elementSelected', (data) => {
      console.log(chalk.green('✓ Element selected:'));
      console.log(chalk.gray(`   File: ${data.file}`));
      console.log(chalk.gray(`   Line: ${data.line}`));
      if (data.column) console.log(chalk.gray(`   Column: ${data.column}`));
      console.log(chalk.gray(`   Framework: ${data.framework || 'unknown'}`));
    });

    console.log(chalk.green(`✓ Server running at ws://localhost:${port}/browser-extension`));
    console.log(chalk.yellow('\n📝 Instructions:'));
    console.log('1. Install the browser extension (run with --install-extension flag)');
    console.log('2. Alt+Click any element in your browser to navigate to its source code');
    console.log('3. The server will output the file location for your editor/MCP to handle\n');

    if (options.installExtension) {
      await installExtension();
    }

    // Keep the process running
    process.on('SIGINT', () => {
      console.log(chalk.red('\n⏹ Shutting down server...'));
      server.close();
      process.exit(0);
    });
  });

program
  .command('install-extension')
  .description('Build and install the browser extension')
  .action(async () => {
    await installExtension();
  });

program
  .command('test')
  .description('Run integration tests with mock browser events')
  .action(async () => {
    console.log(chalk.blue('🧪 Running integration tests...'));

    const server = new BrowserExtensionServer(3001);

    // Simulate browser events
    const testEvents = [
      {
        event: 'elementSelected',
        framework: 'react',
        domPath: 'div#root > div.App > header > h1',
        source: {
          file: 'src/components/Header.tsx',
          line: 15,
          column: 8
        }
      },
      {
        event: 'elementSelected',
        framework: 'vue',
        domPath: 'div#app > main > button.primary',
        source: {
          file: 'src/components/Button.vue',
          line: 23
        }
      },
      {
        event: 'elementSelected',
        framework: null,
        domPath: 'body > div > p',
        fallbackId: 'hanzo-id-12345'
      }
    ];

    console.log(chalk.gray('Sending test events...\n'));

    // Wait for server to start
    await new Promise(resolve => setTimeout(resolve, 1000));

    // Create a mock WebSocket client
    const WebSocket = require('ws');
    const ws = new WebSocket('ws://localhost:3001/browser-extension');

    ws.on('open', () => {
      testEvents.forEach((event, index) => {
        setTimeout(() => {
          console.log(chalk.blue(`→ Sending test event ${index + 1}:`));
          console.log(chalk.gray(JSON.stringify(event, null, 2)));
          ws.send(JSON.stringify(event));
        }, index * 1000);
      });

      setTimeout(() => {
        ws.close();
        server.close();
        console.log(chalk.green('\n✓ Integration tests completed'));
        process.exit(0);
      }, testEvents.length * 1000 + 500);
    });
  });

async function installExtension() {
  console.log(chalk.blue('📦 Building browser extension...'));

  const buildScript = path.join(__dirname, '..', 'browser-extension', 'build.js');

  return new Promise<void>((resolve, reject) => {
    const build = spawn('node', [buildScript], {
      stdio: 'inherit'
    });

    build.on('close', (code) => {
      if (code === 0) {
        console.log(chalk.green('\n✓ Extension built successfully!'));
        console.log(chalk.yellow('\n📝 Installation instructions:'));
        console.log('1. Open Chrome and navigate to chrome://extensions/');
        console.log('2. Enable "Developer mode" (toggle in top right)');
        console.log('3. Click "Load unpacked"');
        console.log(`4. Select the folder: ${path.join(__dirname, '..', '..', 'dist', 'browser-extension')}`);
        console.log('5. The extension is now installed! Alt+Click elements to navigate to source.\n');
        resolve();
      } else {
        reject(new Error(`Build failed with code ${code}`));
      }
    });
  });
}

program.parse();