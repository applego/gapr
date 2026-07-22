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
