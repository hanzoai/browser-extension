#!/usr/bin/env node
/**
 * Test CDP Bridge Connection
 * Verifies the browser extension is connected and can receive commands
 */

const WebSocket = require('ws');

const CDP_PORT = process.env.CDP_PORT || 9223;
const CDP_URL = `ws://localhost:${CDP_PORT}/cdp`;

console.log(`[Test] Connecting to CDP Bridge at ${CDP_URL}...`);

const ws = new WebSocket(CDP_URL);
let commandId = 0;
const pending = new Map();

ws.on('open', () => {
  console.log('[Test] Connected to CDP Bridge');
  console.log('[Test] Registering as client...');

  ws.send(JSON.stringify({
    type: 'register',
    role: 'mcp-client',
    capabilities: ['control', 'screenshot', 'evaluate']
  }));

  // Wait a bit for extension to be ready
  setTimeout(runTests, 1000);
});

ws.on('message', (data) => {
  try {
    const msg = JSON.parse(data.toString());

    if (msg.id !== undefined && pending.has(msg.id)) {
      const { resolve, reject, name } = pending.get(msg.id);
      pending.delete(msg.id);

      if (msg.error) {
        console.log(`[Test] ${name}: FAILED - ${msg.error.message}`);
        reject(new Error(msg.error.message));
      } else {
        console.log(`[Test] ${name}: OK`);
        resolve(msg.result);
      }
    } else if (msg.type === 'event') {
      console.log(`[Test] Event: ${msg.method}`);
    }
  } catch (e) {
    console.error('[Test] Error parsing message:', e);
  }
});

ws.on('error', (err) => {
  console.error('[Test] Connection error:', err.message);
  console.log('[Test] Make sure:');
  console.log('  1. CDP bridge server is running (node dist/cdp-bridge-server.js)');
  console.log('  2. Browser extension is loaded and connected');
  process.exit(1);
});

ws.on('close', () => {
  console.log('[Test] Connection closed');
});

function sendCommand(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++commandId;
    pending.set(id, { resolve, reject, name: method });
    ws.send(JSON.stringify({ id, method, params }));

    // Timeout
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        reject(new Error('Timeout'));
      }
    }, 10000);
  });
}

async function runTests() {
  console.log('\n[Test] Running browser control tests...\n');

  try {
    // Test 1: Get browser version
    console.log('[Test] 1. Getting browser version...');
    const version = await sendCommand('Browser.getVersion');
    console.log(`    Version: ${JSON.stringify(version)}`);

    // Test 2: Get targets (tabs)
    console.log('\n[Test] 2. Getting browser tabs...');
    const targets = await sendCommand('Target.getTargets');
    console.log(`    Found ${targets.targetInfos?.length || 0} tabs`);
    if (targets.targetInfos) {
      targets.targetInfos.forEach((t, i) => {
        console.log(`    [${i}] ${t.title || 'Untitled'} - ${t.url}`);
      });
    }

    // Test 3: Take screenshot
    console.log('\n[Test] 3. Taking screenshot...');
    const screenshot = await sendCommand('hanzo.screenshot', { format: 'png' });
    if (screenshot.data) {
      console.log(`    Screenshot captured: ${screenshot.data.length} bytes (base64)`);
    } else {
      console.log('    No screenshot data returned');
    }

    // Test 4: Evaluate JavaScript
    console.log('\n[Test] 4. Evaluating JavaScript...');
    const evalResult = await sendCommand('Runtime.evaluate', {
      expression: 'document.title',
      returnByValue: true
    });
    console.log(`    Page title: ${evalResult?.result?.value || 'N/A'}`);

    // Test 5: Get page URL
    console.log('\n[Test] 5. Getting page URL...');
    const urlResult = await sendCommand('Runtime.evaluate', {
      expression: 'window.location.href',
      returnByValue: true
    });
    console.log(`    URL: ${urlResult?.result?.value || 'N/A'}`);

    console.log('\n[Test] All tests completed successfully!');
    console.log('[Test] The browser extension is working correctly.\n');

  } catch (err) {
    console.error(`\n[Test] Test failed: ${err.message}`);
    console.log('\n[Test] Troubleshooting:');
    console.log('  1. Is the browser extension loaded?');
    console.log('  2. Is there an active tab in the browser?');
    console.log('  3. Check browser console for extension errors');
  }

  ws.close();
  process.exit(0);
}
