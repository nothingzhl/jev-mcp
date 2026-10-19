import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
try {
  const { values } = parseArgs({ strict: true, allowPositionals: false,
    options: { config: { type: 'string' }, 'dry-run': { type: 'boolean' }, help: { type: 'boolean', short: 'h' } } });
  if (values.help) {
    process.stdout.write('npm run setup:codex -- [--config <config.toml>] [--dry-run]\nInstalls locked dependencies, builds, then registers Jev without storing key values.\n');
  } else {
    const [major, minor] = process.versions.node.split('.').map(Number);
    if (major < 22 || (major === 22 && minor < 16)) throw new Error('Node.js 22.16 or later is required; Node 24 is recommended.');
    if (values.config !== undefined && !values.config.trim()) throw new Error('config must be a nonempty file path.');
    const configPath = resolve(values.config ?? resolve(process.env.CODEX_HOME || resolve(homedir(), '.codex'), 'config.toml'));
    if (values['dry-run']) {
      process.stdout.write(JSON.stringify({ mode: 'plan', projectRoot: root, configPath,
        steps: ['npm ci', 'npm run build', 'jev install-codex'], credentialValuesAdded: false, modelCalls: 0 }, null, 2) + '\n');
    } else {
      const npmCli = process.env.npm_execpath;
      if (!npmCli) throw new Error('Run this installer through npm run setup:codex.');
      const run = (args) => {
        const child = spawnSync(process.execPath, args, { cwd: root, env: process.env, stdio: 'inherit' });
        if (child.error || child.status !== 0) throw new Error('Setup step failed; no later setup step was run.');
      };
      run([npmCli, 'ci', '--no-audit', '--no-fund']);
      run([npmCli, 'run', 'build']);
      run([resolve(root, 'dist/cli.js'), 'install-codex', '--config', configPath]);
    }
  }
} catch (error) {
  // Parsing errors may echo arguments; never relay them or arbitrary child errors.
  const message = error?.code?.startsWith('ERR_PARSE_ARGS') ? 'Invalid setup arguments; use --help.'
    : error instanceof Error && ['Node.js 22.16 or later is required; Node 24 is recommended.',
      'config must be a nonempty file path.', 'Run this installer through npm run setup:codex.',
      'Setup step failed; no later setup step was run.'].includes(error.message) ? error.message : 'Could not complete Codex setup.';
  process.stderr.write(JSON.stringify({ error: message }) + '\n');
  process.exitCode = 1;
}
