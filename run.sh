#!/bin/bash
cd "$(dirname "$0")"
BEEHACK_SESSION_TIMEOUT_MS=30000 node run-simulation.mjs bootstrap --config agents.json 2>&1
BEEHACK_SESSION_TIMEOUT_MS=300000 node run-simulation.mjs run --config agents.json 2>&1
