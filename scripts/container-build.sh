#!/usr/bin/env bash
# Build the application image with immutable provenance (issue 461).
#
# The committed mechanical build path for the container route: builds the
# Dockerfile with its mandatory SOURCE_SHA build arg, verifies the revision
# label actually landed on the built image, and prints the immutable
# provenance record. That record line is what rollback selects — keep it with
# the deployment notes and roll back by re-deploying the recorded image ID
# (or, once the image is pushed to a registry, its registry digest).
#
# Usage: scripts/container-build.sh [tag]
set -euo pipefail

# Resolve the repository root from the script's own location, not the
# caller's cwd: the Dockerfile at the repo root is the build context.
repo_root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$repo_root"

# The revision label must name reviewed committed source, mirroring the host
# path's REVISION discipline (scripts/deploy-revision.sh): a dirty tree would
# label the image with a SHA its source does not match.
if [ -n "$(git status --porcelain)" ]; then
  echo >&2 "ERROR: the working tree is dirty — the revision label must name reviewed committed source. Commit every change and run this script again."
  exit 1
fi

source_sha="$(git rev-parse HEAD)"
image="${1:-overflow-app}"

echo "Building $image from revision $source_sha ..."
docker build --build-arg SOURCE_SHA="$source_sha" -t "$image" .

# Prove the label landed: a build that skipped it would reproduce the
# unlabelled image the issue reports, only silently. The comparison is
# against the same full git rev-parse HEAD the build arg carried.
landed="$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$image")"
if [ "$landed" != "$source_sha" ]; then
  echo >&2 "ERROR: the org.opencontainers.image.revision label on $image is '${landed:-<absent>}' — expected $source_sha. The image carries no usable provenance; do not deploy it."
  exit 1
fi

# The immutable provenance record. RepoDigests stays [] until the image is
# pushed to a registry; until then the image ID is the immutable identity.
created="$(docker image inspect --format '{{.Created}}' "$image")"
image_id="$(docker image inspect --format '{{.Id}}' "$image")"
repo_digests="$(docker image inspect --format '{{json .RepoDigests}}' "$image")"

echo
echo "Provenance record (this line is what rollback selects):"
echo "  revision:    $source_sha"
echo "  image ID:    $image_id"
echo "  RepoDigests: $repo_digests"
echo "  created:     $created"
