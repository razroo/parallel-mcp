#!/usr/bin/env node
import { existsSync, copyFileSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const serverRoot = join(here, '..')
const serverPkgPath = join(serverRoot, 'package.json')
const backupPath = join(serverRoot, 'package.json.prepack-backup')

if (!existsSync(backupPath)) {
  process.stdout.write('postpack: no backup present, nothing to restore\n')
  process.exit(0)
}

copyFileSync(backupPath, serverPkgPath)
rmSync(backupPath)
process.stdout.write('postpack: restored server package.json\n')
