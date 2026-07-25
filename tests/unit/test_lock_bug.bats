#!/usr/bin/env bats

load '../helpers/test_helper'

setup() {
    setup_test_environment
    # We don't load functions here because the script does it
    
    # Define config dir
    CONFIG_DIR="$TEST_PROJECT/.apr"
}

teardown() {
    teardown_test_environment
}

@test "acquire_lock: does not remove existing lock file on failure (fallback)" {
    # Create the reproduction script
    cat > "$TEST_DIR/lock_test.sh" << 'EOF'
#!/usr/bin/env bash
# NOTE: /bin/bash on macOS is 3.2, which cannot parse apr's `exec {FD}<>`
# dynamic file descriptors (exits 127). Use env bash (4+) like apr itself.
set -u

# Source APR functions (strip main)
# Write to a temp file in the same dir as this script (TEST_DIR)
funcs_file="$(dirname "$0")/apr_funcs.bash"
# The copy lives outside the repo, so BASH_SOURCE-based library resolution
# would miss lib/. $3 carries the real repo lib directory.
export APR_LIB_DIR="$3"
sed '/^main "\$@"$/d' "$1" > "$funcs_file"
source "$funcs_file"

# Override CONFIG_DIR to match test env
CONFIG_DIR="$2"
workflow="testflow"
round="1"
mkdir -p "$CONFIG_DIR/.locks"
lock_file="$CONFIG_DIR/.locks/${workflow}_round_${round}.lock"

# Force fallback (disable flock)
function flock() { return 127; }

# Create a lock file owned by init (PID 1) - always running
echo "1" > "$lock_file"

echo "Attempting to acquire lock..."
# Try to acquire lock - should fail
if acquire_lock "$workflow" "$round"; then
    echo "Error: Acquired lock unexpectedly"
    exit 1
fi

echo "Acquire failed (expected). Running cleanup..."

# Simulate trap cleanup
release_lock

if [[ ! -f "$lock_file" ]]; then
    echo "Error: Lock file was deleted!"
    exit 2
fi

echo "Success: Lock file preserved"
EOF
    chmod +x "$TEST_DIR/lock_test.sh"
    
    run "$TEST_DIR/lock_test.sh" "$APR_SCRIPT" "$CONFIG_DIR" "$PROJECT_ROOT/lib"
    
    echo "$output"
    
    if [[ "$status" -eq 2 ]]; then
        # This is what we expect with the bug
        # We want the test to FAIL if the bug is present, so we assert success
        fail "Lock file was deleted by release_lock (Regression)"
    elif [[ "$status" -ne 0 ]]; then
        fail "Script failed with unexpected error"
    fi
}