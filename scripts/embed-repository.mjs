import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { zipSync } from 'fflate';
import { Buffer } from 'node:buffer';
import { createCipheriv, randomBytes } from 'node:crypto';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const gitDir = path.join(root, '.git');
const archivePath = path.join(root, 'public', 'admin', 'base-git.zip');
const metadataPath = path.join(root, 'public', 'admin', 'snapshot.json');
const ENCRYPTED_ARCHIVE_MAGIC = Buffer.from('ASTRAEUS-ENC');

function fail(message) {
  console.error(`Cannot create Git snapshot: ${message}`);
  process.exitCode = 1;
  throw new Error(message);
}

function git(args, options = {}) {
  try {
    return execFileSync('git', args, {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      ...options,
    }).trimEnd();
  } catch (error) {
    fail(`Git command failed (${args.join(' ')}): ${error.stderr?.toString().trim() || error.message}`);
  }
}

async function collectGitFiles(directory, relative = '') {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const files = {};
  for (const entry of entries) {
    const childRelative = relative ? `${relative}/${entry.name}` : entry.name;
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files[`.git/${childRelative}/`] = new Uint8Array();
      Object.assign(files, await collectGitFiles(absolute, childRelative));
    } else if (entry.isFile()) {
      files[`.git/${childRelative}`] = new Uint8Array(await fs.readFile(absolute));
    } else {
      fail(`unsupported special file inside .git: ${childRelative}`);
    }
  }
  return files;
}

async function main() {
  let stat;
  try {
    stat = await fs.stat(gitDir);
  } catch {
    fail('expected a normal Git working copy with a .git directory.');
  }
  if (!stat.isDirectory()) fail('linked worktrees and .git indirection files are unsupported; use a normal clone.');
  if (git(['rev-parse', '--is-bare-repository']) !== 'false') fail('bare repositories are unsupported; build from a checked-out working copy.');

  const branch = git(['symbolic-ref', '--quiet', '--short', 'HEAD']);
  if (!branch || branch.startsWith('(')) fail('detached HEAD is unsupported; check out a named branch.');
  if (git(['rev-parse', '--show-object-format']) !== 'sha1') fail('SHA-256 Git repositories are unsupported by the browser Git/GitHub REST workflow; use SHA-1 objects.');
  const baseSha = git(['rev-parse', '--verify', 'HEAD^{commit}']);
  if (!/^[0-9a-f]{40}$/i.test(baseSha)) fail('Git returned an invalid SHA-1 commit ID.');

  if (await fs.access(path.join(gitDir, 'shallow')).then(() => true, () => false)) {
    fail('shallow history is unsupported; fetch full history (for example, git fetch --unshallow).');
  }
  if (await fs.access(path.join(gitDir, 'objects', 'info', 'alternates')).then(() => true, () => false)) {
    fail('Git object alternates are unsupported; make the repository object database self-contained.');
  }

  const localConfig = git(['config', '--local', '--list']).toLowerCase().split('\n');
  if (localConfig.some((entry) => entry.startsWith('core.worktree='))) {
    fail('repositories with a configured worktree path are unsupported; use a normal clone.');
  }
  if (localConfig.some((entry) => entry.startsWith('extensions.partialclone=') || /^remote\..*\.promisor=true$/.test(entry))) {
    fail('partial clones are unsupported; make sure the complete Git history and object database are present.');
  }

  const submodules = git(['ls-files', '--stage', '-z']).split('\0').filter(Boolean)
    .filter((record) => record.startsWith('160000 '));
  if (submodules.length) fail('repositories containing submodules are unsupported; remove or vendor submodules before building.');

  const tracked = git(['ls-files', '-z']).split('\0').filter(Boolean);
  const generatedRoots = ['dist/', '.astro/', 'node_modules/'];
  const generatedArtifacts = [archivePath, metadataPath].map((artifact) => path.relative(root, artifact).split(path.sep).join('/'));
  const trackedGenerated = tracked.filter((file) => generatedRoots.some((prefix) => file.startsWith(prefix)) || generatedArtifacts.includes(file));
  if (trackedGenerated.length) fail(`generated output must not be tracked: ${trackedGenerated.join(', ')}`);
  if (tracked.length) {
    const attrs = execFileSync('git', ['check-attr', '-z', 'filter', '--stdin'], {
      cwd: root,
      input: `${tracked.join('\0')}\0`,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).split('\0');
    for (let i = 2; i < attrs.length; i += 3) {
      if (attrs[i] === 'lfs') fail('Git LFS-tracked files are unsupported; remove LFS filters before building.');
    }
  }

  if (process.env.ASTRAEUSCMS_ALLOW_DIRTY_SNAPSHOT !== '1' && !process.argv.includes('--allow-dirty')) {
    const status = git(['status', '--porcelain=v1', '--untracked-files=all']);
    if (status) fail(`source tree is not clean. Commit or stash changes before building. Set ASTRAEUSCMS_ALLOW_DIRTY_SNAPSHOT=1 only for local development to bypass this check.\n${status}`);
  }

  await fs.mkdir(path.dirname(archivePath), { recursive: true });
  await fs.rm(archivePath, { force: true });

  const keyHex = process.env.ASTRAEUSCMS_SNAPSHOT_KEY_HEX?.trim() || '';
  if (keyHex && !/^[0-9a-f]{64}$/i.test(keyHex)) {
    fail('ASTRAEUSCMS_SNAPSHOT_KEY_HEX must be exactly 64 hexadecimal characters (32 bytes).');
  }
  const iv = keyHex ? randomBytes(12) : null;
  const metadata = {
    snapshotVersion: 1,
    baseSha,
    branch,
    builtAt: new Date().toISOString(),
    archiveEncryption: iv ? 'aes-256-gcm' : 'none',
    ...(iv ? { archiveIv: iv.toString('base64') } : {}),
  };
  const metadataBytes = new TextEncoder().encode(JSON.stringify(metadata, null, 2));
  const files = await collectGitFiles(gitDir);
  files['snapshot.json'] = metadataBytes;
  let archive = zipSync(files, { level: 6 });
  if (iv) {
    const cipher = createCipheriv('aes-256-gcm', Buffer.from(keyHex, 'hex'), iv);
    const ciphertext = Buffer.concat([cipher.update(archive), cipher.final(), cipher.getAuthTag()]);
    archive = Buffer.concat([ENCRYPTED_ARCHIVE_MAGIC, Buffer.from([1]), iv, ciphertext]);
  }
  await fs.writeFile(archivePath, archive);
  await fs.writeFile(metadataPath, metadataBytes);
}

main().catch((error) => {
  if (!process.exitCode) {
    console.error(error);
    process.exitCode = 1;
  }
});
