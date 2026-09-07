#!/usr/bin/env bash
# Wrapper: the Docker credential helper (credsStore "desktop") hangs image
# resolution indefinitely on this machine, so builds run against a copy of the
# config with credentials stripped. Every image c2w needs is public.
export DOCKER_CONFIG="$HOME/.docker-nocreds"
exec ./build.sh "$@"
