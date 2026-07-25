#!/usr/bin/env bash
# oracle-concurrency.sh — Oracle browser concurrency, auth, and lifecycle helpers.
#
# Shared by `apr` (Oracle/ChatGPT backend) and `gapr` (Gemini default, Oracle
# via `backend: oracle`). Previously these lived only in `apr`, so a gapr run
# with the Oracle backend silently lost serve-pool routing, profile-clone
# fallback, auto-update, and orphan-Chrome reaping.
#
# Sourced, never executed. Expects the host script to provide: verbose,
# print_info, print_success, print_warning, ORACLE_CMD, APR_CACHE,
# ORACLE_FEATURES_DETECTED, APR_ORACLE_PATCHED.

# -----------------------------------------------------------------------------
# Oracle Concurrency & Auth (parallel-safe browser runs)
# -----------------------------------------------------------------------------
# Parallel apr runs sharing ~/.oracle/browser-profile contend on Chrome's
# profile lock, which forces throwaway fresh profiles and repeated ChatGPT
# logins. Two escape hatches, resolved in priority order:
#
#   1. APR_ORACLE_REMOTE=host:port
#      Route runs to a long-lived `oracle serve` daemon (single logged-in
#      browser; sessions are multiplexed server-side, so N parallel runs
#      never touch a local profile). APR_ORACLE_REMOTE_TOKEN supplies the
#      daemon access token.
#
#   2. APR_ORACLE_COPY_PROFILE=1 | <dir>
#      Per-run throwaway clone of the signed-in Chrome profile
#      (default source: ~/.oracle/browser-profile). Heavier than serve
#      (one Chrome per run) but needs no daemon.
#
# Values may also come from ${XDG_CONFIG_HOME:-~/.config}/apr/oracle-remote.env
# so detached/robot runs need no per-shell exports. Environment variables
# always win over the config file.

APR_ORACLE_REMOTE_ENV_FILE="${APR_ORACLE_REMOTE_ENV_FILE:-${XDG_CONFIG_HOME:-$HOME/.config}/apr/oracle-remote.env}"
APR_ORACLE_EXTRA_ARGS=()

load_oracle_remote_env() {
    [[ -f "$APR_ORACLE_REMOTE_ENV_FILE" ]] || return 0
    local line key val
    while IFS= read -r line || [[ -n "$line" ]]; do
        [[ "$line" =~ ^[[:space:]]*# ]] && continue
        [[ "$line" =~ ^[[:space:]]*$ ]] && continue
        key="${line%%=*}"
        val="${line#*=}"
        case "$key" in
            APR_ORACLE_REMOTE|APR_ORACLE_REMOTE_TOKEN|APR_ORACLE_COPY_PROFILE)
                if [[ -z "${!key:-}" ]]; then
                    printf -v "$key" '%s' "$val"
                    export "${key?}"
                fi
                ;;
        esac
    done < "$APR_ORACLE_REMOTE_ENV_FILE"
}

# Populate APR_ORACLE_EXTRA_ARGS with concurrency/auth flags for Oracle.
# -----------------------------------------------------------------------------
# Oracle serve pool (parallel apr across multiple single-flight daemons)
# -----------------------------------------------------------------------------
# `oracle serve` is single-flight (a second POST /runs gets HTTP 409 "busy"),
# so ONE daemon serializes reviews. For true parallelism, APR_ORACLE_REMOTE
# accepts a comma-separated pool ("h1:p1,h2:p2,..."). Each run probes the
# pool, spreads across alive endpoints by a slot hash, and rotates to the
# next endpoint when a retry is needed (busy daemon or dead connection).

APR_ORACLE_REMOTE_POOL=()
APR_ORACLE_REMOTE_INDEX=0

# Liveness probe for one endpoint (overridable in tests).
apr_probe_oracle_remote() {
    local endpoint="$1"
    command -v curl &>/dev/null || return 0  # cannot probe -> assume alive
    curl -s --max-time 2 "http://${endpoint}/status" 2>/dev/null | grep -q '"ok"'
}

# Parse APR_ORACLE_REMOTE, probe candidates, fill APR_ORACLE_REMOTE_POOL and
# pick a starting slot from a seed so parallel runs spread across the pool.
# Returns 1 when no endpoint is alive.
apr_select_oracle_remote() {
    local seed="${1:-$$}"
    APR_ORACLE_REMOTE_POOL=()
    APR_ORACLE_REMOTE_INDEX=0
    local raw="${APR_ORACLE_REMOTE:-}"
    [[ -n "$raw" ]] || return 1
    local -a candidates=()
    IFS=',' read -r -a candidates <<< "$raw"
    local ep
    for ep in ${candidates[@]+"${candidates[@]}"}; do
        ep="${ep// /}"
        [[ -n "$ep" ]] || continue
        if apr_probe_oracle_remote "$ep"; then
            APR_ORACLE_REMOTE_POOL+=("$ep")
        else
            verbose "apr_select_oracle_remote: endpoint $ep unreachable; skipping"
        fi
    done
    [[ ${#APR_ORACLE_REMOTE_POOL[@]} -gt 0 ]] || return 1
    local hash
    hash=$(printf '%s' "$seed" | cksum | awk '{print $1}')
    APR_ORACLE_REMOTE_INDEX=$(( hash % ${#APR_ORACLE_REMOTE_POOL[@]} ))
    return 0
}

apr_current_oracle_remote() {
    [[ ${#APR_ORACLE_REMOTE_POOL[@]} -gt 0 ]] || return 1
    echo "${APR_ORACLE_REMOTE_POOL[$(( APR_ORACLE_REMOTE_INDEX % ${#APR_ORACLE_REMOTE_POOL[@]} ))]}"
}

# Advance to the next pool endpoint (returns 1 when there is nothing to rotate to).
apr_rotate_oracle_remote() {
    [[ ${#APR_ORACLE_REMOTE_POOL[@]} -gt 1 ]] || return 1
    APR_ORACLE_REMOTE_INDEX=$(( (APR_ORACLE_REMOTE_INDEX + 1) % ${#APR_ORACLE_REMOTE_POOL[@]} ))
    verbose "apr_rotate_oracle_remote: now $(apr_current_oracle_remote)"
    return 0
}

# Append with: ${APR_ORACLE_EXTRA_ARGS[@]+"${APR_ORACLE_EXTRA_ARGS[@]}"}
build_oracle_concurrency_args() {
    APR_ORACLE_EXTRA_ARGS=()
    load_oracle_remote_env
    if [[ -n "${APR_ORACLE_REMOTE:-}" ]]; then
        if apr_select_oracle_remote "${APR_ORACLE_SLOT_SEED:-$$}"; then
            local endpoint
            endpoint=$(apr_current_oracle_remote)
            APR_ORACLE_EXTRA_ARGS+=(--remote-host "$endpoint")
            [[ -n "${APR_ORACLE_REMOTE_TOKEN:-}" ]] && APR_ORACLE_EXTRA_ARGS+=(--remote-token "$APR_ORACLE_REMOTE_TOKEN")
            verbose "build_oracle_concurrency_args: remote serve at $endpoint (pool size ${#APR_ORACLE_REMOTE_POOL[@]})"
            return 0
        fi
        print_warning "No reachable oracle serve endpoint in APR_ORACLE_REMOTE=$APR_ORACLE_REMOTE; falling back to local browser"
    fi
    local copy="${APR_ORACLE_COPY_PROFILE:-}"
    if [[ -n "$copy" && "$copy" != "0" && "$copy" != "false" ]]; then
        local profile_dir="$HOME/.oracle/browser-profile"
        [[ "$copy" != "1" && "$copy" != "true" ]] && profile_dir="$copy"
        APR_ORACLE_EXTRA_ARGS+=(--copy-profile "$profile_dir")
        verbose "build_oracle_concurrency_args: per-run profile clone from $profile_dir"
    fi
}

# -----------------------------------------------------------------------------
# Orphaned oracle Chrome reaper (self-healing preflight)
# -----------------------------------------------------------------------------
# Crashed or interrupted oracle runs leave Chrome instances behind (PPID=1)
# holding stale login state. They are NOT safe to reuse (undefined UI state),
# so apr reaps them on preflight instead. Managed daemons are excluded:
# a serve daemon's Chrome has the live serve process as its parent, and
# profiles under ~/.oracle/profiles/ are skipped as an extra guard.

# Pure parser (testable): reads `pid ppid command` lines on stdin and prints
# PIDs of orphaned oracle-spawned Chrome main processes.
apr_orphan_oracle_chrome_pids() {
    local exclude="${1:-/.oracle/profiles/}"
    awk -v exclude="$exclude" '
        $2 == 1 &&
        index($0, "user-data-dir=") > 0 &&
        (index($0, "/.oracle/") > 0 || $0 ~ /user-data-dir=[^ ]*\/oracle-[A-Za-z0-9]/) &&
        index($0, "--type=") == 0 {
            if (exclude != "" && index($0, exclude) > 0) next
            print $1
        }'
}

# Reap orphans (opt out: APR_NO_ORACLE_REAP=1).
reap_orphan_oracle_chrome() {
    [[ -n "${APR_NO_ORACLE_REAP:-}" ]] && return 0
    local pids
    pids=$(ps -ax -o pid=,ppid=,command= 2>/dev/null | apr_orphan_oracle_chrome_pids) || true
    [[ -n "$pids" ]] || return 0
    local pid
    for pid in $pids; do
        verbose "reap_orphan_oracle_chrome: terminating orphan Chrome $pid"
        kill "$pid" 2>/dev/null || true
    done
    print_dim "Reaped orphaned oracle Chrome instance(s): $(echo "$pids" | tr '\n' ' ')"
    return 0
}

# Keep a globally installed Oracle current (policy: always run the latest).
# Throttled to once per APR_ORACLE_UPDATE_INTERVAL_H hours (default 24) via a
# cache stamp. Opt out with APR_ORACLE_NO_AUTOUPDATE=1. Only applies when
# `oracle` is a global npm binary; npx invocations already resolve latest.
# Usage: maybe_autoupdate_oracle <installed_version>
# The installed version is passed in (preflight already probed it) so this
# adds no extra `oracle --version` invocation.
maybe_autoupdate_oracle() {
    local installed="${1:-}"
    [[ -n "${APR_ORACLE_NO_AUTOUPDATE:-}" ]] && return 0
    [[ -n "${CI:-}" ]] && return 0
    [[ -n "$installed" ]] || return 0
    [[ "${ORACLE_CMD[0]:-}" == "oracle" ]] || return 0
    command -v npm &>/dev/null || return 0

    local stamp="$APR_CACHE/oracle-update-check"
    local interval_h="${APR_ORACLE_UPDATE_INTERVAL_H:-24}"
    if [[ -f "$stamp" ]]; then
        local now_s mtime_s age_s
        now_s=$(date +%s)
        mtime_s=$(stat -f %m "$stamp" 2>/dev/null || stat -c %Y "$stamp" 2>/dev/null || echo "$now_s")
        age_s=$(( now_s - mtime_s ))
        (( age_s < interval_h * 3600 )) && return 0
    fi
    mkdir -p "$APR_CACHE" 2>/dev/null || return 0
    touch "$stamp" 2>/dev/null || true

    local latest
    latest=$(npm view @steipete/oracle version 2>/dev/null | head -1) || return 0
    [[ -z "$latest" || "$installed" == "$latest" ]] && return 0

    print_info "Updating Oracle ${installed} -> ${latest} (set APR_ORACLE_NO_AUTOUPDATE=1 to disable)..."
    if npm install -g "@steipete/oracle@${latest}" >/dev/null 2>&1; then
        print_success "Oracle updated to ${latest}"
        # Fresh install: force feature re-detection and stability re-patching.
        # These flags are consumed by the host script (apr/gapr), not here.
        # shellcheck disable=SC2034
        ORACLE_FEATURES_DETECTED=false
        # shellcheck disable=SC2034
        APR_ORACLE_PATCHED=false
    else
        print_warning "Oracle auto-update failed; continuing with ${installed}"
    fi
}
