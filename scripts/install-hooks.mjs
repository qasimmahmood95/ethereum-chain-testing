// Point git at the committed hooks so gitleaks runs pre-commit (CLAUDE.md
// hard rule 1). Runs via npm "prepare"; a failure (e.g. no git, CI tarball
// install) must not break `npm ci`.
import { execSync } from 'node:child_process';

try {
  execSync('git config core.hooksPath .githooks', { stdio: 'ignore' });
} catch {
  // Not a git checkout; nothing to install.
}
