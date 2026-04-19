#!/usr/bin/env node
import { existsSync, copyFileSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const pkgRoot = join(here, '..')
const pkgPath = join(pkgRoot, 'package.json')
const backupPath = join(pkgRoot, 'package.json.prepack-backup')

if (!existsSync(backupPath)) {
  process.stdout.write('postpack: no backup present, nothing to restore\n')
  process.exit(0)
}

copyFileSync(backupPath, pkgPath)
rmSync(backupPath)
process.stdout.write('postpack: restored memory adapter package.json\n')
