#!/usr/bin/env bash
# total-recall SessionStart hook, installed by `recall init`.
# Catch-up ingest so whatever finished since last time is searchable as soon
# as a new session starts (see PLAN.md "Capture"). Never blocks session
# start: ingest failures are swallowed here, surfaced instead by `recall doctor`.
recall ingest >/dev/null 2>&1 || true
