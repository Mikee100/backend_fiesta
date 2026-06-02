const { execSync } = require('child_process');
const path = require('path');

const projectRoot = process.cwd();
const hooksPath = path.join(projectRoot, '.githooks').replace(/\\/g, '/');

try {
  execSync('git rev-parse --is-inside-work-tree', { stdio: 'ignore' });
} catch {
  console.warn('[hooks] Not inside a git worktree. Skipping hook install.');
  process.exit(0);
}

try {
  execSync(`git config core.hooksPath "${hooksPath}"`, { stdio: 'inherit' });
  console.log(`[hooks] Installed git hooks path: ${hooksPath}`);
  console.log('[hooks] pre-commit will run: npm run security:check');
} catch (error) {
  console.error('[hooks] Failed to configure git hooks path.');
  process.exit(1);
}
