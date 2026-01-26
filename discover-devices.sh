#!/bin/bash

# Auto-discover available Zeus devices
# This script calls zeus preview with an invalid device to get the list

DEVICES_FILE="/config/devices.json"

echo "🔍 Discovering available Zeus devices..."

# Call zeus preview with a fake device name to trigger error with device list
ZEUS_OUTPUT=$(zeus preview --target "INVALID_DEVICE_NAME_TO_GET_LIST" 2>&1 || true)

# Extract device names from the error output
# Zeus typically outputs: "Available devices: device1, device2, device3"
# Or lists them line by line

# Try to extract from comma-separated format first
DEVICES=$(echo "$ZEUS_OUTPUT" | grep -oP '(?<=Available devices:).*' | tr ',' '\n' | sed 's/^[[:space:]]*//;s/[[:space:]]*$//' | grep -v '^$')

# If that didn't work, try line-by-line format
if [ -z "$DEVICES" ]; then
    # Look for lines that start with "  - " or similar patterns
    DEVICES=$(echo "$ZEUS_OUTPUT" | grep -E '^\s*-\s+[A-Za-z]' | sed 's/^\s*-\s*//')
fi

# If still nothing, try looking for quoted device names
if [ -z "$DEVICES" ]; then
    DEVICES=$(echo "$ZEUS_OUTPUT" | grep -oP '"[^"]*"' | tr -d '"' | grep -E '^[A-Z]')
fi

if [ -z "$DEVICES" ]; then
    echo "⚠️  Could not auto-discover devices from Zeus CLI"
    echo "Using fallback device list..."
    
    # Fallback to known devices as of January 2026
    cat > "$DEVICES_FILE" <<'EOF'
{
  "devices": [
    "Amazfit Balance",
    "Amazfit Balance 2",
    "Amazfit Active",
    "Amazfit Active Edge",
    "Amazfit Cheetah Pro",
    "Amazfit Cheetah Round",
    "Amazfit Cheetah Square",
    "Amazfit Falcon",
    "Amazfit GTR 3",
    "Amazfit GTR 3 Pro",
    "Amazfit GTR 4",
    "Amazfit GTR Mini",
    "Amazfit GTS 3",
    "Amazfit GTS 4",
    "Amazfit GTS 4 Mini",
    "Amazfit T-Rex 2",
    "Amazfit T-Rex 3",
    "Amazfit T-Rex 3 Pro",
    "Amazfit T-Rex Ultra",
    "Mi Band 7",
    "Mi Band 7 Pro",
    "Zepp OS Simulator"
  ],
  "source": "fallback",
  "updated": "$(date -Iseconds)"
}
EOF
else
    echo "✅ Discovered devices from Zeus CLI"
    
    # Convert to JSON array
    echo "{" > "$DEVICES_FILE"
    echo '  "devices": [' >> "$DEVICES_FILE"
    
    FIRST=true
    while IFS= read -r device; do
        # Skip empty lines
        [ -z "$device" ] && continue
        
        if [ "$FIRST" = true ]; then
            echo "    \"$device\"" >> "$DEVICES_FILE"
            FIRST=false
        else
            echo "    ,\"$device\"" >> "$DEVICES_FILE"
        fi
    done <<< "$DEVICES"
    
    echo '  ],' >> "$DEVICES_FILE"
    echo '  "source": "zeus-cli",' >> "$DEVICES_FILE"
    echo "  \"updated\": \"$(date -Iseconds)\"" >> "$DEVICES_FILE"
    echo "}" >> "$DEVICES_FILE"
fi

# Validate JSON
if command -v jq &> /dev/null; then
    if jq empty "$DEVICES_FILE" 2>/dev/null; then
        DEVICE_COUNT=$(jq '.devices | length' "$DEVICES_FILE")
        echo "✅ Devices file created: $DEVICE_COUNT devices"
        echo "📄 File: $DEVICES_FILE"
    else
        echo "❌ Invalid JSON generated, using fallback"
        # Recreate with fallback
        cat > "$DEVICES_FILE" <<'EOF'
{
  "devices": [
    "Amazfit Balance",
    "Amazfit GTR 4",
    "Amazfit T-Rex 2",
    "Mi Band 7"
  ],
  "source": "fallback-minimal",
  "updated": "$(date -Iseconds)"
}
EOF
    fi
else
    echo "✅ Devices file created (jq not available for validation)"
fi

# Make file readable
chmod 644 "$DEVICES_FILE"

echo ""
echo "📋 Detected devices:"
if command -v jq &> /dev/null; then
    jq -r '.devices[]' "$DEVICES_FILE" | head -10
    TOTAL=$(jq '.devices | length' "$DEVICES_FILE")
    if [ "$TOTAL" -gt 10 ]; then
        echo "... and $((TOTAL - 10)) more"
    fi
else
    head -15 "$DEVICES_FILE"
fi
