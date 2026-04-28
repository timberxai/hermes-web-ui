#!/bin/sh
set -e

IMAGE=hermes-web-ui
DATE_TAG=$(date +%Y.%-m.%-d)

docker build \
  -t "${IMAGE}:latest" \
  -t "${IMAGE}:${DATE_TAG}" \
  .

echo "Built: ${IMAGE}:latest  ${IMAGE}:${DATE_TAG}"
