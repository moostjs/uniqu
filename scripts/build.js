import 'zx/globals'
import { writeFileSync } from 'fs'
import path from 'path'
import { rolldown } from 'rolldown'
import { rollup } from 'rollup'
import dtsPlugin from 'rollup-plugin-dts'
import swcPlugin from 'unplugin-swc'
import { getBuildOptions, getExternals, getWorkspaceFolders } from './utils.js'

const swc = swcPlugin.rolldown()
const target = process.argv[2]

const workspaces = target
  ? getWorkspaceFolders().filter(t => t === target)
  : getWorkspaceFolders()

if (!workspaces.length) {
  console.error('No workspaces found')
  process.exit(1)
}

const externals = new Map()
for (const ws of workspaces) {
  externals.set(ws, getExternals(ws))
}

const FORMATS = {
  esm: { ext: '.mjs', format: 'esm' },
  cjs: { ext: '.cjs', format: 'cjs' },
}

async function run() {
  let types = true
  if (target) {
    console.log(`\nTarget: ${target}\n`)
    types = false
    for (const build of getBuildOptions(target)) {
      if (build.dts !== false) { types = true; break }
    }
  }
  if (types) await generateTypes()
  await generateBundles()
}

async function generateTypes() {
  console.log('\n→ Generating Types...')
  await $`npx tsc`.nothrow()

  for (const ws of workspaces) {
    for (const { entries, dts } of getBuildOptions(ws)) {
      if (!dts) continue
      for (const entry of entries) {
        const p = entry.split('/').slice(0, -1).join('/')
        const source = path.join('./.types', ws, p)
        const dest = path.join('./packages', ws, 'dist', p)
        await $`mkdir -p ./packages/${ws}/dist && rsync -a ${source}/ ${dest}/ --delete`
      }
    }
  }

  for (const ws of workspaces) {
    await rollupTypes(ws)
  }

  await $`rm -rf ./.types`
}

async function rollupTypes(ws) {
  const files = []
  for (const { entries, dts } of getBuildOptions(ws)) {
    if (!dts) continue
    for (const entry of entries) {
      const fileName = entry.split('/').pop().replace(/\.\w+$/u, '')
      const p = entry.split('/').slice(0, -1).join('/')
      const input = path.join('packages', ws, 'dist', p, `${fileName}.d.ts`)
      const bundle = await rollup({
        input,
        plugins: [dtsPlugin()],
        external: externals.get(ws),
      })
      const { output } = await bundle.generate({ format: 'esm' })
      files.push({ name: `./packages/${ws}/dist/${fileName}.d.ts`, code: output[0].code })
    }
  }
  await $`rm -rf ./packages/${ws}/dist`
  await $`mkdir -p ./packages/${ws}/dist`
  for (const f of files) {
    writeFileSync(f.name, f.code)
    console.log(`  ✅ ${f.name}`)
  }
}

async function generateBundles() {
  console.log('\n→ Building Bundles...')
  for (const ws of workspaces) {
    await rolldownPackage(ws)
  }
}

async function rolldownPackage(ws) {
  for (const { entries, formats, external } of getBuildOptions(ws)) {
    for (const entry of entries) {
      const bundle = await rolldown({
        input: path.join(`packages/${ws}`, entry),
        external: [...(external || externals.get(ws))],
        resolve: {
          extensions: ['.ts', '.mjs', '.js', '.json'],
        },
        plugins: [swc],
      })
      const fileName = entry.split('/').pop().replace(/\.\w+$/u, '')
      const created = []
      for (const f of formats) {
        const { ext, format } = FORMATS[f]
        const { output } = await bundle.generate({ format })
        const target = `./packages/${ws}/dist/${fileName}${ext}`
        writeFileSync(target, output[0].code)
        created.push(target)
      }
      console.log(`  ✅ ${created.join('\t')}`)
    }
  }
}

run()
