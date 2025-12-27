#!/usr/bin/env bash
# Test Gemini models against the cloudcode API
# Refreshes OAuth token if expired and tests each model
#
# Usage: test-gemini-models.sh [project-id]
#   If project-id is not provided, it will be auto-detected via loadCodeAssist
# Example: test-gemini-models.sh
# Example: test-gemini-models.sh gen-lang-client-0884090445

set -uo pipefail

OAUTH_FILE="$HOME/.gemini/oauth_creds.json"
CLIENT_ID="681255809395-oo8ft2oprdrnp9e3aqf6av3hmdib135j.apps.googleusercontent.com"
CLIENT_SECRET="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"
CODE_ASSIST_ENDPOINT="https://cloudcode-pa.googleapis.com/v1internal"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Check dependencies
for cmd in jq curl; do
    if ! command -v "$cmd" &> /dev/null; then
        echo "Error: $cmd is required but not installed."
        exit 1
    fi
done

# Check oauth file exists
if [[ ! -f "$OAUTH_FILE" ]]; then
    echo "Error: OAuth credentials not found at $OAUTH_FILE"
    echo "Run 'gemini' to authenticate first."
    exit 1
fi

# Get current timestamp in milliseconds
now_ms=$(date +%s%3N)

# Read current credentials
expiry_date=$(jq -r '.expiry_date' "$OAUTH_FILE")
refresh_token=$(jq -r '.refresh_token' "$OAUTH_FILE")

# Refresh token if expired or expiring within 60 seconds
if (( expiry_date < now_ms + 60000 )); then
    echo "Refreshing OAuth token..."
    response=$(curl -s -X POST "https://oauth2.googleapis.com/token" \
        -H "Content-Type: application/json" \
        -d "{
            \"client_id\": \"$CLIENT_ID\",
            \"client_secret\": \"$CLIENT_SECRET\",
            \"refresh_token\": \"$refresh_token\",
            \"grant_type\": \"refresh_token\"
        }")

    if echo "$response" | jq -e '.error' > /dev/null 2>&1; then
        echo "Error refreshing token:"
        echo "$response" | jq .
        exit 1
    fi

    # Calculate new expiry (expires_in is in seconds, we store milliseconds)
    expires_in=$(echo "$response" | jq -r '.expires_in')
    new_expiry=$(($(date +%s%3N) + expires_in * 1000 - 60000))

    # Update oauth file
    new_access_token=$(echo "$response" | jq -r '.access_token')
    jq --arg at "$new_access_token" --argjson ed "$new_expiry" \
        '.access_token = $at | .expiry_date = $ed' "$OAUTH_FILE" > "${OAUTH_FILE}.tmp" \
        && mv "${OAUTH_FILE}.tmp" "$OAUTH_FILE"

    echo "Token refreshed successfully."
fi

# Get access token
ACCESS_TOKEN=$(jq -r '.access_token' "$OAUTH_FILE")

# Auto-detect project ID via loadCodeAssist if not provided
if [[ $# -ge 1 ]]; then
    PROJECT="$1"
else
    echo "Auto-detecting project ID via loadCodeAssist..."
    response=$(curl -s -X POST "${CODE_ASSIST_ENDPOINT}:loadCodeAssist" \
        -H "Content-Type: application/json" \
        -H "Authorization: Bearer $ACCESS_TOKEN" \
        -H "user-agent: GeminiCLI/v22.12.0" \
        -d '{
            "metadata": {
                "ideType": "IDE_UNSPECIFIED",
                "platform": "PLATFORM_UNSPECIFIED",
                "pluginType": "GEMINI"
            }
        }')

    if ! echo "$response" | jq -e '.cloudaicompanionProject' > /dev/null 2>&1; then
        echo "Error: Failed to auto-detect project ID"
        echo "Response: $response"
        exit 1
    fi

    PROJECT=$(echo "$response" | jq -r '.cloudaicompanionProject')
    echo "Detected project ID: $PROJECT"
fi

echo ""
echo "Testing Gemini models on cloudcode API"
echo "Project: $PROJECT"
echo "Time: $(date)"
echo "========================================"
echo ""

# Models to test (all models from gc provider in config.json)
MODELS=(
    "gemini-3-pro-preview"
    "gemini-3-flash-preview"
    "gemini-2.5-pro"
    "gemini-2.5-flash"
    "gemini-2.5-flash-lite"
)

test_model() {
    local model="$1"
    local response
    local http_code

    # Make request and capture both body and http code
    response=$(curl -s -w "\n%{http_code}" -X POST "https://cloudcode-pa.googleapis.com/v1internal:generateContent" \
        -H "Authorization: Bearer $ACCESS_TOKEN" \
        -H "Content-Type: application/json" \
        -H "user-agent: GeminiCLI/v22.12.0" \
        -d "{
            \"request\": {
                \"contents\": [{\"role\": \"user\", \"parts\": [{\"text\": \"Say hi\"}]}]
            },
            \"model\": \"$model\",
            \"project\": \"$PROJECT\"
        }" 2>&1)

    http_code=$(echo "$response" | tail -n1)
    body=$(echo "$response" | sed '$d')

    if [[ "$http_code" == "200" ]]; then
        # Check if response has actual content
        if echo "$body" | jq -e '.response.candidates[0].content' > /dev/null 2>&1; then
            local model_version=$(echo "$body" | jq -r '.response.modelVersion // "unknown"')
            local tokens=$(echo "$body" | jq -r '.response.usageMetadata.totalTokenCount // "?"')
            printf "${GREEN}✓${NC} %-25s ${GREEN}OK${NC} (version: %s, tokens: %s)\n" "$model" "$model_version" "$tokens"
            return 0
        fi
    fi

    # Extract error message
    local error_msg=$(echo "$body" | jq -r '.error.message // .error // "Unknown error"' 2>/dev/null || echo "Unknown error")
    local error_code=$(echo "$body" | jq -r '.error.code // empty' 2>/dev/null)

    if [[ "$error_code" == "404" ]]; then
        printf "${RED}✗${NC} %-25s ${RED}NOT FOUND${NC} (model removed or unavailable)\n" "$model"
    elif [[ "$error_code" == "403" ]]; then
        printf "${YELLOW}⚠${NC} %-25s ${YELLOW}FORBIDDEN${NC} (no access to this model)\n" "$model"
    elif [[ "$error_code" == "429" ]]; then
        printf "${YELLOW}⚠${NC} %-25s ${YELLOW}RATE LIMITED${NC}\n" "$model"
    else
        printf "${RED}✗${NC} %-25s ${RED}ERROR${NC} (HTTP %s: %s)\n" "$model" "$http_code" "$error_msg"
    fi
    return 1
}

# Run tests
working=0
failed=0

for model in "${MODELS[@]}"; do
    if test_model "$model"; then
        ((working++))
    else
        ((failed++))
    fi
done

echo ""
echo "========================================"
echo "Results: $working working, $failed failed"
