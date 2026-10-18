#!/usr/bin/env bash
# 上游 codeg 发版触发器：personal token 调 repository_dispatch 唤醒 fork 的 fork-release workflow。
# cron 建议：每 6 小时一次（上游更新再频繁也足够及时）。
# 用法：CODEG_DISPATCH_TOKEN=ghp_xxx ./upstream-release-trigger.sh
set -euo pipefail
: "${CODEG_DISPATCH_TOKEN:?need a personal access token with repo scope}"
curl -sS -X POST \
  -H "Accept: application/vnd.github+json" \
  -H "Authorization: Bearer $CODEG_DISPATCH_TOKEN" \
  https://api.github.com/repos/unixcs/codeg/dispatches \
  -d '{"event_type":"upstream-release","client_payload":{}}'
echo "dispatch sent"
