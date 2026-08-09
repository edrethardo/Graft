// Self-heals the tree-sitter-swift native build, then prints a one-line nudge.
// Never fails the install.
//
// tree-sitter-swift ships no prebuilds, and its gyp build expects
// tree-sitter-cli at a NESTED path (tree-sitter-swift/node_modules/…) that npm
// hoists away — so a plain `npm install` leaves it uncompiled. The fix is
// mechanical (link the hoisted cli where the makefile looks, rebuild) and
// belongs here so a fresh clone works with no manual steps. Runs only when the
// compiled binding is actually missing; a failure degrades to "Swift files are
// skipped" (the build banner says so), never to a broken install.
try {
  const { existsSync } = await import('node:fs');
  const { join, dirname } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  const swiftDir = join(root, 'node_modules', 'tree-sitter-swift');
  const built = existsSync(join(swiftDir, 'build', 'Release', 'tree_sitter_swift_binding.node'));
  if (existsSync(swiftDir) && !built) {
    const { execSync } = await import('node:child_process');
    const { mkdirSync, symlinkSync, rmSync } = await import('node:fs');
    const nested = join(swiftDir, 'node_modules', 'tree-sitter-cli');
    mkdirSync(join(swiftDir, 'node_modules'), { recursive: true });
    rmSync(nested, { recursive: true, force: true });
    symlinkSync(join('..', '..', 'tree-sitter-cli'), nested, 'junction');
    if (!existsSync(join(root, 'node_modules', 'tree-sitter-cli', 'tree-sitter'))) {
      execSync('npm rebuild tree-sitter-cli', { cwd: root, stdio: 'ignore' });
    }
    execSync('npx node-gyp rebuild', { cwd: swiftDir, stdio: 'ignore' });
  }
} catch {
  /* Swift stays unindexed; the build banner reports it — never fail an install */
}

try {
  if (process.env.CI) process.exit(0);
  const { existsSync } = await import('node:fs');
  const { join } = await import('node:path');
  const dir = process.env.INIT_CWD || process.cwd();
  if (existsSync(join(dir, '.claude', 'helpers', 'graft-statusline.cjs'))) process.exit(0);
  console.log('\n  Graft installed. Run `npx graft init` to enable the Claude Code integration (statusline + hooks + auto-sync).\n');
} catch {
  /* never fail an install */
}
