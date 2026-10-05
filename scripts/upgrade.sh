#!/bin/bash

# Upgrade every workspace package.json (root + apps/* + packages/*) to the
# latest versions, leaving the workspace:* internal refs (@packages/* and
# @geniro/*) untouched, then reinstall. Monorepo recursion + root inclusion come
# from .ncurc.json (workspaces: true, root: true) — don't pass --deep/--workspaces here too.
# Run as `pnpm run upgrade`: bare `pnpm upgrade` is pnpm's built-in alias for
# `pnpm update` and never reaches this script.
#pnpm update --latest --recursive
#
# zod and nestjs-zod are held, and lifted together:
# - zod ~4.4: from 4.5 on, a root `.meta({ id })` schema is emitted as a `$ref`
#   and nestjs-zod's cleanupOpenApiDoc refuses the daemon's boot ("Found
#   multiple schemas with name …") — BenLorantfy/nestjs-zod#475.
# - nestjs-zod ~5.4: 5.5 registers each named schema under its bare id AND as
#   `<Id>_Output`, which canonicalizeOpenApiSchemas does not merge, so the
#   generated client grows `*Output` twins of every shared enum.
# Lift both once #475 ships AND `pnpm generate:api` produces an empty diff.
#
# The fastify and socket.io `overrides` in pnpm-workspace.yaml are exact pins
# this script never moves: after an upgrade, set each to the version
# @nestjs/platform-fastify / @nestjs/platform-socket.io pins (or newer).
#
# typescript is held at ^6: typescript-eslint and @nestjs/swagger declare peers
# below 7, and `peer: true` cannot see that from a workspace that depends on
# neither, so ncu would move those workspaces alone onto a second compiler.
ncu -u --reject "/^(@(packages|geniro)\/|zod$|nestjs-zod$|typescript$)/"
pnpm install
