#!/usr/bin/env node
/**
 * prepack: rewrite the workspace-relative dependency on `@razroo/parallel-mcp`
 * to the published semver range of the root package so the tarball is usable
 * off of this monorepo.
 *
 * A matching `postpack` restores the original file so day-to-day development
 * keeps resolving via the local workspace link.
 */
import { readFileSync, writeFileSync, copyFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const serverRoot = join(here, '..')
const repoRoot = join(serverRoot, '..')

const serverPkgPath = join(serverRoot, 'package.json')
const backupPath = join(serverRoot, 'package.json.prepack-backup')
const rootPkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'))

copyFileSync(serverPkgPath, backupPath)

const pkg = JSON.parse(readFileSync(serverPkgPath, 'utf8'))
if (!pkg.dependencies || typeof pkg.dependencies['@razroo/parallel-mcp'] !== 'string') {
  throw new Error('server package.json has no @razroo/parallel-mcp dependency')
}

const previous = pkg.dependencies['@razroo/parallel-mcp']
const next = `^${rootPkg.version}`
pkg.dependencies['@razroo/parallel-mcp'] = next

writeFileSync(serverPkgPath, `${JSON.stringify(pkg, null, 2)}\n`)

process.stdout.write(
  `prepack: rewrote @razroo/parallel-mcp dependency from "${previous}" to "${next}"\n`,
)
