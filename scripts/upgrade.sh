#!/bin/bash

# Upgrade every workspace package.json (root + apps/* + packages/*) to the
# latest versions, leaving the workspace:* internal refs (@packages/* and
# @geniro/*) untouched, then reinstall. Monorepo recursion + root inclusion come
# from .ncurc.json (workspaces: true, root: true) — don't pass --deep/--workspaces here too.
#pnpm update --latest --recursive
ncu -u --reject "/^@(packages|geniro)\//"
pnpm install
