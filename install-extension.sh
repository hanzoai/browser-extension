#!/bin/bash
# Hanzo Browser Extension Installer
# Provides instructions and opens browser extension pages

EXTENSION_DIR="$(dirname "$0")/dist/browser-extension"

echo "=== Hanzo Browser Extension Installer ==="
echo ""
echo "Extension directories:"
echo "  Chrome:  $EXTENSION_DIR/chrome"
echo "  Firefox: $EXTENSION_DIR/firefox"
echo "  Safari:  $EXTENSION_DIR/safari (requires Xcode)"
echo ""

# Check if servers are running
if lsof -i :3001 > /dev/null 2>&1; then
    echo "✓ Browser Extension Server running on port 3001"
else
    echo "✗ Browser Extension Server NOT running"
    echo "  Start with: node dist/browser-extension/cli.js start"
fi

if lsof -i :9223 > /dev/null 2>&1; then
    echo "✓ CDP Bridge Server running on port 9223"
else
    echo "✗ CDP Bridge Server NOT running"
    echo "  Start with: node dist/cdp-bridge-server.js"
fi

echo ""
echo "=== Installation Instructions ==="
echo ""

# Chrome
echo "CHROME:"
echo "  1. Open chrome://extensions/"
echo "  2. Enable 'Developer mode'"
echo "  3. Click 'Load unpacked'"
echo "  4. Select: $EXTENSION_DIR"
echo ""

# Firefox
echo "FIREFOX:"
echo "  1. Open about:debugging#/runtime/this-firefox"
echo "  2. Click 'Load Temporary Add-on...'"
echo "  3. Select: $EXTENSION_DIR/firefox/manifest.json"
echo ""

# Safari
echo "SAFARI:"
echo "  1. Open Xcode"
echo "  2. Create new Safari Web Extension project"
echo "  3. Copy files from: $EXTENSION_DIR/safari/"
echo "  4. Build and run"
echo ""

# Open browser extension pages based on arguments
case "$1" in
    chrome)
        open -a "Google Chrome" "chrome://extensions/"
        ;;
    firefox)
        open -a "Firefox Developer Edition" "about:debugging#/runtime/this-firefox" 2>/dev/null || \
        open -a "Firefox" "about:debugging#/runtime/this-firefox"
        ;;
    all)
        open -a "Google Chrome" "chrome://extensions/"
        open -a "Firefox Developer Edition" "about:debugging#/runtime/this-firefox" 2>/dev/null || \
        open -a "Firefox" "about:debugging#/runtime/this-firefox"
        ;;
    *)
        echo "Usage: $0 [chrome|firefox|all]"
        echo "  Opens the extension management page in the specified browser"
        ;;
esac
