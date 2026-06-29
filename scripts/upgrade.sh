#!/bin/bash

#pnpm update --latest --recursive
ncu -u --reject "/^@packages\//"
pnpm install
