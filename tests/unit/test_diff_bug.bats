#!/usr/bin/env bats

load '../helpers/test_helper'

setup() {
    setup_test_environment
    # Don't load functions here, use script
    
    CONFIG_DIR="$TEST_PROJECT/.apr"
    WORKFLOW="testflow"
    mkdir -p "$CONFIG_DIR/workflows" "$CONFIG_DIR/rounds/$WORKFLOW"
    
    echo "name: testflow" > "$CONFIG_DIR/workflows/$WORKFLOW.yaml"
    echo "content_A" > "$CONFIG_DIR/rounds/$WORKFLOW/round_3.md"
    echo "content_prev" > "$CONFIG_DIR/rounds/$WORKFLOW/round_4.md"
    echo "content_B" > "$CONFIG_DIR/rounds/$WORKFLOW/round_5.md"

    mkdir -p "$TEST_DIR/bin"
    cat > "$TEST_DIR/bin/delta" << 'EOF'
#!/bin/bash
echo "MOCK_DELTA args: $@"
EOF
    chmod +x "$TEST_DIR/bin/delta"
}

teardown() {
    teardown_test_environment
}

@test "diff_rounds: compares rounds in correct order (N vs M)" {
    # Create runner script
    cat > "$TEST_DIR/run_diff.sh" << 'EOF'
#!/bin/bash
set -e
# Source APR functions
# The copy lives outside the repo, so apr's BASH_SOURCE-based library lookup
# would miss lib/. The last argument carries the real repo lib directory.
export APR_LIB_DIR="${!#}"
funcs_file="$(dirname "$0")/apr_funcs.bash"
sed '/^main "\$@"$/d' "$1" > "$funcs_file"
source "$funcs_file"

# Override globals
CONFIG_DIR="$2"
WORKFLOW="testflow"

# Run diff_rounds
diff_rounds "$3" "$4"
EOF
    chmod +x "$TEST_DIR/run_diff.sh"

    # Run with custom PATH
    (
        export PATH="$TEST_DIR/bin:$PATH"
        run "$TEST_DIR/run_diff.sh" "$APR_SCRIPT" "$CONFIG_DIR" "3" "5" "$PROJECT_ROOT/lib"
        
        echo "$output"
        assert_success
        [[ "$output" == *"round_3.md"* && "$output" == *"round_5.md"* ]] || fail "Delta filenames missing"
        # Check order by string position or regex
        # BATS doesn't have assert_output_regex easily available in subshell context without loading
        
        # Simple bash regex
        if [[ "$output" =~ round_3\.md.*round_5\.md ]]; then
            true
        else
            fail "Delta order wrong (expected 3 then 5)"
        fi
    )
}

@test "diff_rounds: compares previous round correctly (N vs N-1)" {
    # Create runner script
    cat > "$TEST_DIR/run_diff_single.sh" << 'EOF'
#!/bin/bash
set -e
# The copy lives outside the repo, so apr's BASH_SOURCE-based library lookup
# would miss lib/. The last argument carries the real repo lib directory.
export APR_LIB_DIR="${!#}"
funcs_file="$(dirname "$0")/apr_funcs.bash"
sed '/^main "\$@"$/d' "$1" > "$funcs_file"
source "$funcs_file"

CONFIG_DIR="$2"
WORKFLOW="testflow"

diff_rounds "$3"
EOF
    chmod +x "$TEST_DIR/run_diff_single.sh"

    (
        export PATH="$TEST_DIR/bin:$PATH"
        run "$TEST_DIR/run_diff_single.sh" "$APR_SCRIPT" "$CONFIG_DIR" "5" "$PROJECT_ROOT/lib"
        
        echo "$output"
        assert_success
        
        if [[ "$output" =~ round_4\.md.*round_5\.md ]]; then
            true
        else
            fail "Delta order wrong (expected 4 then 5)"
        fi
    )
}