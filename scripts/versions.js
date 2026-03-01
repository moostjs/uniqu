import 'zx/globals'
import { readFileSync, writeFileSync } from 'fs'
import inquirer from 'inquirer'
import { getWorkspaceFolders } from './utils.js'

function syncVersions(newVersion) {
  for (const ws of getWorkspaceFolders()) {
    const packagePath = `./packages/${ws}/package.json`
    const packageData = JSON.parse(readFileSync(packagePath, 'utf8'))
    packageData.version = newVersion
    writeFileSync(packagePath, JSON.stringify(packageData, null, 2))
    console.log(`  ✅ Updated ${ws} to ${newVersion}`)
  }
}

async function main() {
  // Check for uncommitted changes
  const { stdout: status } = await $`git status --porcelain`
  if (status.trim() !== '') {
    console.error('❌ Uncommitted changes found. Commit or stash before releasing.')
    process.exit(1)
  }

  // Read current version and calculate bumps
  const pkg = JSON.parse(readFileSync('./package.json', 'utf8'))
  const [major, minor, patch] = pkg.version.split('.').map(Number)
  const versions = {
    patch: `${major}.${minor}.${patch + 1}`,
    minor: `${major}.${minor + 1}.0`,
    major: `${major + 1}.0.0`,
  }

  // Prompt for bump type
  const { bump } = await inquirer.prompt([{
    type: 'list',
    name: 'bump',
    message: `Current: ${pkg.version}. Select bump:`,
    choices: [
      { name: `Patch → ${versions.patch}`, value: 'patch' },
      { name: `Minor → ${versions.minor}`, value: 'minor' },
      { name: `Major → ${versions.major}`, value: 'major' },
    ],
  }])

  console.log(`\n🚀 Bumping: ${pkg.version} → ${versions[bump]}\n`)

  // Bump root, sync packages, commit, tag, push
  await $`pnpm version ${bump} --no-git-tag-version`
  const newVersion = JSON.parse(readFileSync('./package.json', 'utf8')).version
  syncVersions(newVersion)

  await $`git add package.json packages/*/package.json`
  await $`git commit -m "chore: release version ${newVersion}"`
  await $`git tag v${newVersion} -m "Release version ${newVersion}"`
  await $`git push --follow-tags`
  console.log('\n✅ Released successfully!')
}

await main()
