#!/usr/bin/env bash
# gemini-helper.sh — Gemini API profile management, API calls, and SSE stream parsing
# Sourced by gapr; do not execute directly.

# ---------------------------------------------------------------------------
# Profile & API Key Resolution
# ---------------------------------------------------------------------------
# Priority: --profile flag > workflow YAML > GEMINI_API_KEY env > profiles.yaml default

GAPR_PROFILES_DIR="${GAPR_PROFILES_DIR:-$HOME/.gapr}"
GAPR_PROFILES_FILE="${GAPR_PROFILES_DIR}/profiles.yaml"

# Thinking level → budget mapping
# Gemini thinkingBudget: 0 = none, 1024 = low, 8192 = medium, 24576 = high, -1 = max
thinking_level_to_budget() {
    local level="${1:-high}"
    case "$level" in
        none|off|0)     echo 0 ;;
        minimal|min)    echo 1024 ;;
        low)            echo 4096 ;;
        medium|med)     echo 8192 ;;
        high)           echo 24576 ;;
        max|maximum|-1) echo -1 ;;
        *)
            # If it's a raw number, pass through
            if [[ "$level" =~ ^-?[0-9]+$ ]]; then
                echo "$level"
            else
                echo 24576  # default to high
            fi
            ;;
    esac
}

# Load a value from profiles.yaml using awk (no yq dependency)
# Usage: _gapr_profile_value <profile_name> <key>
_gapr_profile_value() {
    local profile="$1"
    local key="$2"
    local file="$GAPR_PROFILES_FILE"

    [[ ! -f "$file" ]] && return 1

    awk -v profile="$profile" -v key="$key" '
    BEGIN { in_profiles=0; in_target=0; found=0 }
    /^profiles:/ { in_profiles=1; next }
    in_profiles && /^[^ ]/ { in_profiles=0 }
    in_profiles && $0 ~ "^  " profile ":" { in_target=1; next }
    in_target && /^  [^ ]/ && $0 !~ "^    " { in_target=0 }
    in_target && $0 ~ "^    " key ":" {
        val = $0
        sub(/^[^:]*:[[:space:]]*/, "", val)
        gsub(/^["'\''"]|["'\''"]$/, "", val)
        print val
        found=1
        exit
    }
    END { if (!found) exit 1 }
    ' "$file"
}

# Get the default profile name from profiles.yaml
_gapr_default_profile() {
    local file="$GAPR_PROFILES_FILE"
    [[ ! -f "$file" ]] && return 1

    awk '/^default_profile:/ {
        val = $0
        sub(/^[^:]*:[[:space:]]*/, "", val)
        gsub(/^["'\''"]|["'\''"]$/, "", val)
        print val
        exit
    }' "$file"
}

# Resolve the Gemini API key.
# Args: [profile_name_override]
# Returns: API key on stdout, or returns 1 if not found.
get_gemini_api_key() {
    local profile_override="${1:-}"

    # 1. Explicit profile from --profile flag or workflow YAML
    if [[ -n "$profile_override" ]]; then
        local key
        key=$(_gapr_profile_value "$profile_override" "api_key") && {
            printf '%s' "$key"
            return 0
        }
        # Profile specified but not found — fall through to env
    fi

    # 2. GEMINI_API_KEY environment variable
    if [[ -n "${GEMINI_API_KEY:-}" ]]; then
        printf '%s' "$GEMINI_API_KEY"
        return 0
    fi

    # 3. Default profile in profiles.yaml
    if [[ -f "$GAPR_PROFILES_FILE" ]]; then
        local default_profile
        default_profile=$(_gapr_default_profile) || true
        if [[ -n "$default_profile" ]]; then
            local key
            key=$(_gapr_profile_value "$default_profile" "api_key") && {
                printf '%s' "$key"
                return 0
            }
        fi
    fi

    return 1
}

# ---------------------------------------------------------------------------
# SSE Stream Parser
# ---------------------------------------------------------------------------
# Gemini streamGenerateContent returns SSE events with JSON payloads.
# We extract .candidates[0].content.parts[].text from each data: line,
# skipping thought parts (which have .thought = true).

parse_sse_stream() {
    local line text
    while IFS= read -r line; do
        # Strip trailing \r from SSE lines
        line="${line%$'\r'}"
        case "$line" in
            data:\ *)
                # Remove "data: " prefix
                local json="${line#data: }"
                # Skip [DONE] sentinel
                [[ "$json" == "[DONE]" ]] && continue
                # Extract text from all parts, skipping thought parts
                text=$(printf '%s' "$json" | jq -r '
                    .candidates[0].content.parts[]?
                    | select(.thought != true)
                    | .text // empty
                ' 2>/dev/null) || continue
                [[ -n "$text" ]] && printf '%s' "$text"
                ;;
        esac
    done
}

# ---------------------------------------------------------------------------
# Gemini API Call
# ---------------------------------------------------------------------------
# call_gemini <api_key> <model> <thinking_level> <prompt> [file_contents...]
#
# Sends a prompt to the Gemini API with optional thinking budget.
# File contents are prepended to the prompt as context.
# Output is streamed to stdout.
# Returns 0 on success, 1 on error.

call_gemini() {
    local api_key="$1"
    local model="$2"
    local thinking_level="$3"
    local prompt="$4"
    shift 4
    local file_contents=("$@")

    local thinking_budget
    thinking_budget=$(thinking_level_to_budget "$thinking_level")

    # Build the full prompt with file contents prepended
    local full_prompt="$prompt"
    if [[ ${#file_contents[@]} -gt 0 ]]; then
        local preamble=""
        for fc in "${file_contents[@]}"; do
            preamble+="$fc"$'\n\n'
        done
        full_prompt="${preamble}${prompt}"
    fi

    # Escape the prompt for JSON embedding
    local escaped_prompt
    escaped_prompt=$(printf '%s' "$full_prompt" | jq -Rs '.')

    # Build the request JSON
    local request_body
    if [[ "$thinking_budget" -eq 0 ]]; then
        # No thinking — omit thinkingConfig entirely
        request_body=$(jq -nc \
            --argjson prompt "$escaped_prompt" \
            '{
                contents: [{parts: [{text: $prompt}]}]
            }')
    else
        request_body=$(jq -nc \
            --argjson prompt "$escaped_prompt" \
            --argjson budget "$thinking_budget" \
            '{
                contents: [{parts: [{text: $prompt}]}],
                generationConfig: {
                    thinkingConfig: {thinkingBudget: $budget}
                }
            }')
    fi

    # Call the Gemini API with streaming
    local url="https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?alt=sse&key=${api_key}"

    local http_code  # shellcheck disable=SC2034
    local tmp_headers
    tmp_headers=$(mktemp)

    curl -sS --connect-timeout 15 --max-time 3600 \
        -H "Content-Type: application/json" \
        -d "$request_body" \
        -D "$tmp_headers" \
        "$url" 2>/dev/null | parse_sse_stream

    local curl_exit=${PIPESTATUS[0]}
    # shellcheck disable=SC2034
    local parse_exit=${PIPESTATUS[1]}

    rm -f "$tmp_headers"

    if [[ $curl_exit -ne 0 ]]; then
        return 1
    fi

    return 0
}

# call_gemini_blocking — non-streaming variant, returns full text at once.
# Useful for short prompts or when streaming isn't needed.
call_gemini_blocking() {
    local api_key="$1"
    local model="$2"
    local thinking_level="$3"
    local prompt="$4"
    shift 4
    local file_contents=("$@")

    local thinking_budget
    thinking_budget=$(thinking_level_to_budget "$thinking_level")

    # Build the full prompt with file contents prepended
    local full_prompt="$prompt"
    if [[ ${#file_contents[@]} -gt 0 ]]; then
        local preamble=""
        for fc in "${file_contents[@]}"; do
            preamble+="$fc"$'\n\n'
        done
        full_prompt="${preamble}${prompt}"
    fi

    # Escape the prompt for JSON embedding
    local escaped_prompt
    escaped_prompt=$(printf '%s' "$full_prompt" | jq -Rs '.')

    # Build the request JSON
    local request_body
    if [[ "$thinking_budget" -eq 0 ]]; then
        request_body=$(jq -nc \
            --argjson prompt "$escaped_prompt" \
            '{
                contents: [{parts: [{text: $prompt}]}]
            }')
    else
        request_body=$(jq -nc \
            --argjson prompt "$escaped_prompt" \
            --argjson budget "$thinking_budget" \
            '{
                contents: [{parts: [{text: $prompt}]}],
                generationConfig: {
                    thinkingConfig: {thinkingBudget: $budget}
                }
            }')
    fi

    local url="https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${api_key}"

    local response
    response=$(curl -sS --connect-timeout 15 --max-time 3600 \
        -H "Content-Type: application/json" \
        -d "$request_body" \
        "$url" 2>/dev/null) || return 1

    # Check for API errors
    local error_msg
    error_msg=$(printf '%s' "$response" | jq -r '.error.message // empty' 2>/dev/null)
    if [[ -n "$error_msg" ]]; then
        echo "Gemini API error: $error_msg" >&2
        return 1
    fi

    # Extract text from response, skipping thought parts
    printf '%s' "$response" | jq -r '
        .candidates[0].content.parts[]
        | select(.thought != true)
        | .text // empty
    ' 2>/dev/null

    return 0
}
