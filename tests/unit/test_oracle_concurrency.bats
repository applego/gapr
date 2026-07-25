#!/usr/bin/env bats
# test_oracle_concurrency.bats - Unit tests for Oracle concurrency & auth args
#
# Covers:
#   - build_oracle_concurrency_args (remote serve / copy-profile / precedence)
#   - load_oracle_remote_env (config file parsing, env-wins precedence)

load '../helpers/test_helper'

setup() {
    setup_test_environment
    log_test_start "${BATS_TEST_NAME}"
    load_apr_functions

    # Isolate from any real user config
    export APR_ORACLE_REMOTE_ENV_FILE="$TEST_DIR/oracle-remote.env"
    unset APR_ORACLE_REMOTE APR_ORACLE_REMOTE_TOKEN APR_ORACLE_COPY_PROFILE 2>/dev/null || true

    # Default probe stub: endpoints are alive (individual tests override)
    apr_probe_oracle_remote() { return 0; }
}

teardown() {
    log_test_end "${BATS_TEST_NAME}" "$([[ ${status:-0} -eq 0 ]] && echo pass || echo fail)"
    unset APR_ORACLE_REMOTE APR_ORACLE_REMOTE_TOKEN APR_ORACLE_COPY_PROFILE 2>/dev/null || true
    teardown_test_environment
}

# =============================================================================
# build_oracle_concurrency_args
# =============================================================================

@test "concurrency args: empty when nothing configured" {
    build_oracle_concurrency_args
    [[ ${#APR_ORACLE_EXTRA_ARGS[@]} -eq 0 ]]
}

@test "concurrency args: APR_ORACLE_REMOTE adds --remote-host" {
    export APR_ORACLE_REMOTE="127.0.0.1:4870"
    build_oracle_concurrency_args
    [[ "${APR_ORACLE_EXTRA_ARGS[0]}" == "--remote-host" ]]
    [[ "${APR_ORACLE_EXTRA_ARGS[1]}" == "127.0.0.1:4870" ]]
    [[ ${#APR_ORACLE_EXTRA_ARGS[@]} -eq 2 ]]
}

@test "concurrency args: remote token appended when set" {
    export APR_ORACLE_REMOTE="127.0.0.1:4870"
    export APR_ORACLE_REMOTE_TOKEN="secret-token"
    build_oracle_concurrency_args
    [[ "${APR_ORACLE_EXTRA_ARGS[2]}" == "--remote-token" ]]
    [[ "${APR_ORACLE_EXTRA_ARGS[3]}" == "secret-token" ]]
}

@test "concurrency args: APR_ORACLE_COPY_PROFILE=1 uses default profile dir" {
    export APR_ORACLE_COPY_PROFILE="1"
    build_oracle_concurrency_args
    [[ "${APR_ORACLE_EXTRA_ARGS[0]}" == "--copy-profile" ]]
    [[ "${APR_ORACLE_EXTRA_ARGS[1]}" == "$HOME/.oracle/browser-profile" ]]
}

@test "concurrency args: APR_ORACLE_COPY_PROFILE=<dir> uses custom dir" {
    export APR_ORACLE_COPY_PROFILE="$TEST_DIR/custom-profile"
    build_oracle_concurrency_args
    [[ "${APR_ORACLE_EXTRA_ARGS[1]}" == "$TEST_DIR/custom-profile" ]]
}

@test "concurrency args: COPY_PROFILE=0/false disables cloning" {
    export APR_ORACLE_COPY_PROFILE="0"
    build_oracle_concurrency_args
    [[ ${#APR_ORACLE_EXTRA_ARGS[@]} -eq 0 ]]
    export APR_ORACLE_COPY_PROFILE="false"
    build_oracle_concurrency_args
    [[ ${#APR_ORACLE_EXTRA_ARGS[@]} -eq 0 ]]
}

@test "concurrency args: remote takes precedence over copy-profile" {
    export APR_ORACLE_REMOTE="127.0.0.1:4870"
    export APR_ORACLE_COPY_PROFILE="1"
    build_oracle_concurrency_args
    [[ "${APR_ORACLE_EXTRA_ARGS[0]}" == "--remote-host" ]]
    for arg in ${APR_ORACLE_EXTRA_ARGS[@]+"${APR_ORACLE_EXTRA_ARGS[@]}"}; do
        [[ "$arg" != "--copy-profile" ]]
    done
}

# =============================================================================
# load_oracle_remote_env (config file)
# =============================================================================

@test "remote env file: values loaded when env unset" {
    cat > "$APR_ORACLE_REMOTE_ENV_FILE" <<EOF
# comment line
APR_ORACLE_REMOTE=10.0.0.5:4870
APR_ORACLE_REMOTE_TOKEN=file-token
EOF
    build_oracle_concurrency_args
    [[ "${APR_ORACLE_EXTRA_ARGS[1]}" == "10.0.0.5:4870" ]]
    [[ "${APR_ORACLE_EXTRA_ARGS[3]}" == "file-token" ]]
}

@test "remote env file: environment variables win over file" {
    cat > "$APR_ORACLE_REMOTE_ENV_FILE" <<EOF
APR_ORACLE_REMOTE=10.0.0.5:4870
EOF
    export APR_ORACLE_REMOTE="127.0.0.1:9999"
    build_oracle_concurrency_args
    [[ "${APR_ORACLE_EXTRA_ARGS[1]}" == "127.0.0.1:9999" ]]
}

@test "remote env file: unknown keys ignored" {
    cat > "$APR_ORACLE_REMOTE_ENV_FILE" <<EOF
SOME_RANDOM_KEY=evil
APR_ORACLE_REMOTE=10.0.0.5:4870
EOF
    build_oracle_concurrency_args
    [[ -z "${SOME_RANDOM_KEY:-}" ]]
    [[ "${APR_ORACLE_EXTRA_ARGS[1]}" == "10.0.0.5:4870" ]]
}

@test "remote env file: missing file is a no-op" {
    rm -f "$APR_ORACLE_REMOTE_ENV_FILE"
    build_oracle_concurrency_args
    [[ ${#APR_ORACLE_EXTRA_ARGS[@]} -eq 0 ]]
}

# =============================================================================
# Serve pool (apr_select_oracle_remote / rotation)
# =============================================================================

@test "pool: comma list selects an alive endpoint deterministically" {
    export APR_ORACLE_REMOTE="h1:1111,h2:2222,h3:3333"
    apr_probe_oracle_remote() { return 0; }
    export APR_ORACLE_SLOT_SEED="fixed-seed"
    build_oracle_concurrency_args
    [[ "${APR_ORACLE_EXTRA_ARGS[0]}" == "--remote-host" ]]
    local first="${APR_ORACLE_EXTRA_ARGS[1]}"
    build_oracle_concurrency_args
    [[ "${APR_ORACLE_EXTRA_ARGS[1]}" == "$first" ]]
    [[ ${#APR_ORACLE_REMOTE_POOL[@]} -eq 3 ]]
}

@test "pool: dead endpoints are skipped" {
    export APR_ORACLE_REMOTE="dead:1111,alive:2222"
    apr_probe_oracle_remote() { [[ "$1" == "alive:2222" ]]; }
    build_oracle_concurrency_args
    [[ "${APR_ORACLE_EXTRA_ARGS[1]}" == "alive:2222" ]]
    [[ ${#APR_ORACLE_REMOTE_POOL[@]} -eq 1 ]]
}

@test "pool: all endpoints dead falls back to copy-profile" {
    export APR_ORACLE_REMOTE="dead:1111,dead:2222"
    export APR_ORACLE_COPY_PROFILE="1"
    apr_probe_oracle_remote() { return 1; }
    build_oracle_concurrency_args
    [[ "${APR_ORACLE_EXTRA_ARGS[0]}" == "--copy-profile" ]]
}

@test "pool: rotation cycles through endpoints" {
    export APR_ORACLE_REMOTE="h1:1,h2:2"
    apr_probe_oracle_remote() { return 0; }
    apr_select_oracle_remote "seed"
    local a b c
    a=$(apr_current_oracle_remote)
    apr_rotate_oracle_remote
    b=$(apr_current_oracle_remote)
    apr_rotate_oracle_remote
    c=$(apr_current_oracle_remote)
    [[ "$a" != "$b" ]]
    [[ "$a" == "$c" ]]
}

@test "pool: single endpoint does not rotate" {
    export APR_ORACLE_REMOTE="only:1"
    apr_probe_oracle_remote() { return 0; }
    apr_select_oracle_remote "seed"
    run apr_rotate_oracle_remote
    [[ "$status" -ne 0 ]]
}

# =============================================================================
# Orphan Chrome reaper parser
# =============================================================================

@test "reaper: orphaned oracle chrome (ppid=1) is matched" {
    local out
    out=$(printf '%s\n' \
      '111 1 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome --user-data-dir=/Users/u/.oracle/browser-profile-apr-fresh https://chatgpt.com/' \
      | apr_orphan_oracle_chrome_pids)
    [[ "$out" == "111" ]]
}

@test "reaper: chrome with live parent is not matched" {
    local out
    out=$(printf '%s\n' \
      '222 5555 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome --user-data-dir=/Users/u/.oracle/browser-profile' \
      | apr_orphan_oracle_chrome_pids)
    [[ -z "$out" ]]
}

@test "reaper: renderer subprocesses (--type=) are excluded" {
    local out
    out=$(printf '%s\n' \
      '333 1 /Applications/Google Chrome.app/... --type=renderer --user-data-dir=/Users/u/.oracle/browser-profile' \
      | apr_orphan_oracle_chrome_pids)
    [[ -z "$out" ]]
}

@test "reaper: non-oracle chrome profiles are excluded" {
    local out
    out=$(printf '%s\n' \
      '444 1 /Applications/Google Chrome.app/... --user-data-dir=/Users/u/Library/Application Support/Google/Chrome' \
      | apr_orphan_oracle_chrome_pids)
    [[ -z "$out" ]]
}

@test "reaper: serve daemon profiles dir is excluded" {
    local out
    out=$(printf '%s\n' \
      '555 1 /Applications/Google Chrome.app/... --user-data-dir=/Users/u/.oracle/profiles/chatgpt-primary' \
      | apr_orphan_oracle_chrome_pids)
    [[ -z "$out" ]]
}

@test "reaper: temp oracle profiles are matched" {
    local out
    out=$(printf '%s\n' \
      '666 1 /Applications/Google Chrome.app/... --user-data-dir=/var/folders/xx/T/oracle-reattach-abc123 https://chatgpt.com/' \
      | apr_orphan_oracle_chrome_pids)
    [[ "$out" == "666" ]]
}

# =============================================================================
# Library distribution invariants (regression guards)
# =============================================================================

@test "apr declares APR_REQUIRED_LIBS so self-update ships the library" {
    # Without the declaration the update loop silently iterates zero times and
    # leaves an updated apr unable to start (it exits 3 without the library).
    grep -q '^readonly APR_REQUIRED_LIBS=(' "$APR_SCRIPT"
    run bash -c "source <(sed '/^main \"\$@\"\$/d' '$APR_SCRIPT') >/dev/null 2>&1; printf '%s' \"\${APR_REQUIRED_LIBS[*]}\""
    [[ "$output" == *"oracle-concurrency.sh"* ]]
}

@test "install.sh declares LIB_FILES so fresh installs ship the library" {
    grep -q '^readonly LIB_FILES=(' "$PROJECT_ROOT/install.sh"
}

@test "no bad array-length substitution (\${#arr[@]:-0}) in shipped scripts" {
    # `${#arr[@]:-0}` is a bash "bad substitution" and aborts at runtime.
    # Strip comments first: the pattern is legitimately named in a code comment.
    run bash -c "sed 's/#.*//' '$APR_SCRIPT' '$PROJECT_ROOT/gapr' '$PROJECT_ROOT/lib/oracle-concurrency.sh' | grep -nE '\\\$\\{#[A-Za-z_][A-Za-z0-9_]*\\[@\\]:-'"
    [[ "$status" -ne 0 ]]
}
