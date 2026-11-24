import git from 'isomorphic-git';
import LightningFS from '@isomorphic-git/lightning-fs';
import { unzipSync, zipSync } from 'fflate';
import { isExcludedPreviewPath, isSafePreviewSymlink } from './preview-paths.js';
import { Buffer } from 'buffer';
globalThis.Buffer = Buffer;

const FS_NAME = 'AstraeusCMS-admin-repository';
const LEGACY_FS_NAME = 'astro-cms-admin-repository';
const MIGRATION_MARKER = '/.astraeuscms-legacy-migration';
const REPO_DIR = '/repo';
const WORKSPACE_DIR = '/workspace-meta';
const READY_FILE = `${WORKSPACE_DIR}/initialized.json`;
const INITIALIZATION_FILE = `${WORKSPACE_DIR}/initializing.json`;
const RESET_STAGING_DIR = '/repo-reset-staging';
const RESET_BACKUP_DIR = '/repo-reset-backup';
const fs = new LightningFS();
const pfs = fs.promises;
const legacyFs = new LightningFS();
const legacyPfs = legacyFs.promises;
const ENCRYPTED_ARCHIVE_MAGIC = new TextEncoder().encode('ASTRAEUS-ENC');
const ENCRYPTED_ARCHIVE_VERSION = 1;
const SNAPSHOT_KEY_REQUIRED = 'SNAPSHOT_ENCRYPTION_KEY_REQUIRED';
const SNAPSHOT_KEY_INVALID = 'SNAPSHOT_ENCRYPTION_KEY_INVALID';
let initialized;
let snapshot;
let publishedSnapshot = null;
let queue = Promise.resolve();

function repoPath(value) {
  if (typeof value !== 'string' || !value || value.includes('\\') || value.includes('\0') || value.startsWith('/')) {
    throw new Error('Enter a repository-relative path.');
  }
  const segments = value.split('/');
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) {
    throw new Error('Paths cannot contain empty, current, or parent-directory segments.');
  }
  if (segments.includes('.git')) {
    throw new Error('The .git directory is reserved for Git metadata.');
  }
  return segments.join('/');
}

function zipPath(value) {
  const path = value.replace(/^\.\//, '').replace(/\\/g, '/');
  const parts = path.split('/');
  if (!path || path.startsWith('/') || parts.some((part) => part === '..' || part === '.')) return null;
  return path;
}

async function mkdirp(directory) {
  if (!directory || directory === '/') return;
  const parts = directory.split('/').filter(Boolean);
  let current = '';
  for (const part of parts) {
    current += `/${part}`;
    try { await pfs.mkdir(current); } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
  }
}

function validateSnapshotMetadata(metadata, label) {
  if (metadata?.snapshotVersion !== 1) {
    throw new Error(`Unsupported ${label} snapshot version: ${metadata?.snapshotVersion ?? 'missing'}.`);
  }
  if (typeof metadata.baseSha !== 'string' || !/^[0-9a-f]{40}$/i.test(metadata.baseSha) || typeof metadata.branch !== 'string' || !metadata.branch) {
    throw new Error(`The ${label} snapshot metadata is missing its branch or a valid base commit.`);
  }
  const archiveEncryption = metadata.archiveEncryption ?? 'none';
  if (!['none', 'aes-256-gcm'].includes(archiveEncryption)) {
    throw new Error(`The ${label} snapshot metadata has an unsupported archive encryption mode.`);
  }
  if (archiveEncryption === 'aes-256-gcm' && !/^[A-Za-z0-9+/]{16}$/.test(metadata.archiveIv || '')) {
    throw new Error(`The ${label} snapshot metadata is missing a valid AES-GCM IV.`);
  }
  if (archiveEncryption === 'none' && metadata.archiveIv !== undefined) {
    throw new Error(`The ${label} plaintext snapshot must not include an encryption IV.`);
  }
  return { ...metadata, archiveEncryption };
}

function bytesToBase64(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function hasEncryptedArchiveHeader(bytes) {
  return bytes.length >= ENCRYPTED_ARCHIVE_MAGIC.length
    && ENCRYPTED_ARCHIVE_MAGIC.every((byte, index) => bytes[index] === byte);
}

async function decryptSnapshotArchive(bytes, keyHex, expectedMetadata) {
  if (!hasEncryptedArchiveHeader(bytes)) {
    if (expectedMetadata?.archiveEncryption === 'aes-256-gcm') {
      throw new Error('The published metadata says this snapshot is encrypted, but the ZIP is plaintext.');
    }
    return { bytes, archiveIv: null };
  }
  const ivStart = ENCRYPTED_ARCHIVE_MAGIC.length + 1;
  const payloadStart = ivStart + 12;
  if (bytes.length < payloadStart + 16 || bytes[ENCRYPTED_ARCHIVE_MAGIC.length] !== ENCRYPTED_ARCHIVE_VERSION) {
    throw new Error('The encrypted repository snapshot has an invalid or unsupported envelope.');
  }
  const iv = bytes.slice(ivStart, payloadStart);
  const archiveIv = bytesToBase64(iv);
  if (expectedMetadata && (expectedMetadata.archiveEncryption !== 'aes-256-gcm' || expectedMetadata.archiveIv !== archiveIv)) {
    throw new Error('The encrypted repository ZIP does not match the published snapshot metadata.');
  }
  if (!keyHex) throw new Error(SNAPSHOT_KEY_REQUIRED);
  if (!/^[0-9a-f]{64}$/i.test(keyHex)) throw new Error(SNAPSHOT_KEY_INVALID);

  const rawKey = new Uint8Array(32);
  for (let index = 0; index < rawKey.length; index++) {
    rawKey[index] = Number.parseInt(keyHex.slice(index * 2, index * 2 + 2), 16);
  }
  const key = await self.crypto.subtle.importKey('raw', rawKey, { name: 'AES-GCM' }, false, ['decrypt']);
  try {
    const plaintext = await self.crypto.subtle.decrypt(
      { name: 'AES-GCM', iv, tagLength: 128 },
      key,
      bytes.subarray(payloadStart),
    );
    return { bytes: new Uint8Array(plaintext), archiveIv };
  } catch {
    throw new Error(SNAPSHOT_KEY_INVALID);
  }
}

async function fetchPublishedSnapshot(baseUrl) {
  const sidecarUrl = new URL('admin/snapshot.json', new URL(baseUrl, self.location.origin));
  let response;
  try { response = await fetch(sidecarUrl, { cache: 'no-store' }); } catch {
    throw new Error('Could not reach the current published snapshot metadata. Check the connection and try again.');
  }
  if (!response.ok) throw new Error(`Could not load published snapshot metadata (${response.status}).`);
  return validateSnapshotMetadata(await response.json(), 'published');
}

async function fetchPublishedArchive(baseUrl, encryptionKeyHex = '') {
  const published = await fetchPublishedSnapshot(baseUrl);
  const archiveUrl = new URL('admin/base-git.zip', new URL(baseUrl, self.location.origin));
  let response;
  try { response = await fetch(archiveUrl, { cache: 'no-store' }); } catch {
    throw new Error('Could not download the current server repository ZIP. Check the connection and try again.');
  }
  if (!response.ok) throw new Error(`Could not load the server repository ZIP (${response.status}).`);
  const encryptedBytes = new Uint8Array(await response.arrayBuffer());
  const decoded = await decryptSnapshotArchive(encryptedBytes, encryptionKeyHex, published);
  let archive;
  try { archive = unzipSync(decoded.bytes); } catch {
    throw new Error('The server repository ZIP is invalid or could not be unpacked.');
  }
  const metadataBytes = archive['snapshot.json'];
  if (!metadataBytes) throw new Error('The repository ZIP is missing snapshot.json.');
  let parsedMetadata;
  try { parsedMetadata = JSON.parse(new TextDecoder().decode(metadataBytes)); } catch {
    throw new Error('The repository ZIP snapshot metadata is invalid.');
  }
  const metadata = validateSnapshotMetadata(parsedMetadata, 'repository ZIP');
  if (metadata.baseSha !== published.baseSha || metadata.branch !== published.branch
    || metadata.archiveEncryption !== published.archiveEncryption
    || metadata.archiveIv !== published.archiveIv
    || metadata.archiveIv !== (decoded.archiveIv || undefined)) {
    throw new Error('The repository ZIP does not match the current published snapshot metadata. Retry after the deployment finishes.');
  }
  return { published, archive, metadata };
}

async function materializeSnapshot(directory, archive, metadata) {
  await mkdirp(directory);
  let gitEntries = 0;
  for (const [entryName, contents] of Object.entries(archive)) {
    const safeName = zipPath(entryName);
    if (!safeName || safeName.endsWith('/') || !safeName.startsWith('.git/')) continue;
    const relative = safeName.slice('.git/'.length);
    if (!relative) continue;
    const path = `${directory}/.git/${relative}`;
    await mkdirp(path.slice(0, path.lastIndexOf('/')));
    await pfs.writeFile(path, contents);
    gitEntries++;
  }
  if (!gitEntries) throw new Error('The repository archive does not contain a Git database.');
  await git.checkout({ fs, dir: directory, ref: metadata.branch, force: true });
  const checkedOutHead = await git.resolveRef({ fs, dir: directory, ref: 'HEAD' });
  if (checkedOutHead !== metadata.baseSha) throw new Error('The snapshot branch does not point at its declared base commit.');
  const matrix = await git.statusMatrix({ fs, dir: directory });
  if (matrix.some(([, head, workdir, stage]) => head !== workdir || head !== stage)) {
    throw new Error('The repository snapshot did not produce a clean working tree.');
  }
}

async function pathExists(path) {
  try { await pfs.lstat(path); return true; } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

async function removeTree(path) {
  let stat;
  try { stat = await pfs.lstat(path); } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
  if (stat.isDirectory()) {
    for (const name of await pfs.readdir(path)) await removeTree(`${path}/${name}`);
    await pfs.rmdir(path);
  } else {
    await pfs.unlink(path);
  }
}

async function copyLegacyPath(sourcePath, targetPath) {
  const stat = await legacyPfs.lstat(sourcePath);
  const mode = stat.mode & 0o777;
  if (stat.isDirectory()) {
    await pfs.mkdir(targetPath, { mode });
    for (const name of await legacyPfs.readdir(sourcePath)) {
      await copyLegacyPath(`${sourcePath}/${name}`, `${targetPath}/${name}`);
    }
    await pfs.chmod(targetPath, mode);
  } else if (stat.isSymbolicLink()) {
    await pfs.symlink(await legacyPfs.readlink(sourcePath), targetPath);
  } else if (stat.isFile()) {
    await pfs.writeFile(targetPath, await legacyPfs.readFile(sourcePath), { mode });
  } else {
    throw new Error(`Cannot migrate unsupported browser file: ${sourcePath}`);
  }
}

async function recoverInterruptedMigration() {
  const entries = await pfs.readdir('/');
  if (!entries.includes(MIGRATION_MARKER.slice(1))) return;
  for (const name of entries) await removeTree(`/${name}`);
  await pfs.flush();
}

async function recoverInterruptedInitialization() {
  let marker;
  try { marker = await pfs.readFile(INITIALIZATION_FILE, 'utf8'); } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
  if (marker === undefined) return;

  let ready;
  try { ready = await pfs.readFile(READY_FILE, 'utf8'); } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  if (ready === undefined) await removeTree(REPO_DIR);
  await pfs.unlink(INITIALIZATION_FILE);
  await pfs.flush();
}

async function migrateLegacyWorkspace() {
  await legacyFs.init(LEGACY_FS_NAME);
  const legacyEntries = await legacyPfs.readdir('/');
  let legacyReady;
  try { legacyReady = await legacyPfs.readFile(READY_FILE, 'utf8'); } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  if (legacyReady === undefined) {
    let repoEntries = [];
    try { repoEntries = await legacyPfs.readdir(REPO_DIR); } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    if (repoEntries.length) {
      throw new Error('An older AstraeusCMS browser workspace has repository files but no initialization marker. Its data is untouched; export it from the previous deployment before continuing.');
    }
    return false;
  }
  if ((await pfs.readdir('/')).length) {
    throw new Error('AstraeusCMS found data in its new browser workspace and will not overwrite it during migration.');
  }

  await pfs.writeFile(MIGRATION_MARKER, 'in-progress', 'utf8');
  await pfs.flush();
  try {
    for (const name of legacyEntries) await copyLegacyPath(`/${name}`, `/${name}`);
    await pfs.unlink(MIGRATION_MARKER);
    await pfs.flush();
  } catch (error) {
    await pfs.flush();
    throw new Error(`Could not migrate the previous browser workspace. Its original data remains untouched; reload to retry. ${error.message}`);
  }
  return true;
}

async function comparePublishedSnapshot(baseUrl) {
  publishedSnapshot = null;
  const sidecarUrl = new URL('admin/snapshot.json', new URL(baseUrl, self.location.origin));
  let response;
  try { response = await fetch(sidecarUrl, { cache: 'no-cache' }); } catch { return; }
  if (!response.ok) return;
  publishedSnapshot = validateSnapshotMetadata(await response.json(), 'published');
}

async function ensureInitialized(baseUrl, encryptionKeyHex = '') {
  if (initialized) return initialized;
  initialized = (async () => {
    await fs.init(FS_NAME);
    await recoverInterruptedMigration();
    await recoverInterruptedInitialization();

    let saved;
    try {
      saved = await pfs.readFile(READY_FILE, 'utf8');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    if (saved === undefined) {
      await migrateLegacyWorkspace();
      try {
        saved = await pfs.readFile(READY_FILE, 'utf8');
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
    }
    if (saved !== undefined) {
      snapshot = JSON.parse(saved);
      if (snapshot?.snapshotVersion !== 1) {
        throw new Error(`Unsupported saved repository snapshot version: ${snapshot?.snapshotVersion ?? 'missing'}.`);
      }
      if (!snapshot.baseSha || !snapshot.branch) throw new Error('Saved repository metadata is missing its branch or base commit.');
      await git.resolveRef({ fs, dir: REPO_DIR, ref: 'HEAD' });
      await comparePublishedSnapshot(baseUrl);
      return;
    }

    await comparePublishedSnapshot(baseUrl);
    let existingRepoEntries = [];
    try {
      existingRepoEntries = await pfs.readdir(REPO_DIR);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    if (existingRepoEntries.length) {
      throw new Error('Repository data exists without its initialization marker. An initial load may have been interrupted; use Reset to snapshot to replace this browser workspace, which discards local changes.');
    }

    const archiveUrl = new URL('admin/base-git.zip', new URL(baseUrl, self.location.origin));
    const response = await fetch(archiveUrl, { cache: 'no-store' });
    if (!response.ok) throw new Error(`Could not load the repository snapshot (${response.status}).`);
    const encryptedBytes = new Uint8Array(await response.arrayBuffer());
    const decoded = await decryptSnapshotArchive(encryptedBytes, encryptionKeyHex, publishedSnapshot);
    let archive;
    try { archive = unzipSync(decoded.bytes); } catch {
      throw new Error('The repository snapshot ZIP is invalid or could not be unpacked.');
    }
    const metadataBytes = archive['snapshot.json'];
    if (!metadataBytes) throw new Error('The repository archive is missing snapshot.json.');
    const metadata = validateSnapshotMetadata(JSON.parse(new TextDecoder().decode(metadataBytes)), 'repository archive');
    if (metadata.archiveIv !== (decoded.archiveIv || undefined)) {
      throw new Error('The decrypted repository ZIP metadata does not match its encrypted archive header.');
    }
    if (publishedSnapshot && (metadata.baseSha !== publishedSnapshot.baseSha || metadata.branch !== publishedSnapshot.branch
      || metadata.archiveEncryption !== publishedSnapshot.archiveEncryption || metadata.archiveIv !== publishedSnapshot.archiveIv)) {
      throw new Error('The repository ZIP does not match the published snapshot metadata. Reload and try again.');
    }
    await mkdirp(WORKSPACE_DIR);
    await pfs.writeFile(INITIALIZATION_FILE, 'in-progress', 'utf8');
    await pfs.flush();
    await materializeSnapshot(REPO_DIR, archive, metadata);
    await pfs.flush();
    snapshot = {
      snapshotVersion: metadata.snapshotVersion,
      baseSha: metadata.baseSha,
      branch: metadata.branch,
      builtAt: metadata.builtAt,
      archiveEncryption: metadata.archiveEncryption,
    };
    await pfs.writeFile(READY_FILE, JSON.stringify(snapshot), 'utf8');
    await pfs.flush();
    await pfs.unlink(INITIALIZATION_FILE);
    await pfs.flush();
    await comparePublishedSnapshot(baseUrl);
  })().catch((error) => {
    initialized = null;
    throw error;
  });
  return initialized;
}

async function listFiles() {
  const files = [];
  async function visit(directory) {
    for (const name of await pfs.readdir(directory)) {
      if (directory === REPO_DIR && name === '.git') continue;
      const fullPath = `${directory}/${name}`;
      const stat = await pfs.lstat(fullPath);
      if (stat.isDirectory()) await visit(fullPath);
      else if (stat.isFile() || stat.isSymbolicLink()) {
        const path = fullPath.slice(REPO_DIR.length + 1);
        files.push({ path, size: stat.size });
      }
    }
  }
  await visit(REPO_DIR);
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

async function status() {
  const matrix = await git.statusMatrix({ fs, dir: REPO_DIR });
  return matrix.map(([path, head, workdir, stage]) => ({ path, head, workdir, stage }));
}

const MAX_INLINE_DIFF_BYTES = 256 * 1024;
const MAX_DIFF_CELLS = 300_000;
const MAX_DIFF_LINES = 2_000;

function decodeDiffText(bytes) {
  if (bytes.includes(0)) return null;
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { return null; }
}

function diffLines(beforeText, afterText) {
  const before = beforeText === '' ? [] : beforeText.split(/\r?\n/);
  const after = afterText === '' ? [] : afterText.split(/\r?\n/);
  if (beforeText.endsWith('\n')) before.pop();
  if (afterText.endsWith('\n')) after.pop();
  const columns = after.length + 1;
  const cells = (before.length + 1) * columns;
  if (cells > MAX_DIFF_CELLS) {
    return { kind: 'large', message: 'Inline diff skipped because this file has too many lines for a safe preview.' };
  }

  const lcs = new Uint32Array(cells);
  for (let oldIndex = before.length - 1; oldIndex >= 0; oldIndex--) {
    for (let newIndex = after.length - 1; newIndex >= 0; newIndex--) {
      const index = oldIndex * columns + newIndex;
      lcs[index] = before[oldIndex] === after[newIndex]
        ? lcs[(oldIndex + 1) * columns + newIndex + 1] + 1
        : Math.max(lcs[(oldIndex + 1) * columns + newIndex], lcs[index + 1]);
    }
  }

  const operations = [];
  let oldIndex = 0;
  let newIndex = 0;
  while (oldIndex < before.length || newIndex < after.length) {
    if (oldIndex < before.length && newIndex < after.length && before[oldIndex] === after[newIndex]) {
      operations.push({ type: 'context', oldLine: oldIndex + 1, newLine: newIndex + 1, text: before[oldIndex] });
      oldIndex++;
      newIndex++;
    } else if (newIndex < after.length && (oldIndex === before.length || lcs[oldIndex * columns + newIndex + 1] > lcs[(oldIndex + 1) * columns + newIndex])) {
      operations.push({ type: 'addition', newLine: newIndex + 1, text: after[newIndex] });
      newIndex++;
    } else {
      operations.push({ type: 'removal', oldLine: oldIndex + 1, text: before[oldIndex] });
      oldIndex++;
    }
  }

  const added = operations.filter((operation) => operation.type === 'addition').length;
  const removed = operations.filter((operation) => operation.type === 'removal').length;
  if (added + removed > MAX_DIFF_LINES) {
    return { kind: 'large', message: `Inline diff skipped because it contains more than ${MAX_DIFF_LINES.toLocaleString()} changed lines.` };
  }
  const ranges = [];
  for (let index = 0; index < operations.length; index++) {
    if (operations[index].type === 'context') continue;
    const start = Math.max(0, index - 3);
    const end = Math.min(operations.length - 1, index + 3);
    const previous = ranges[ranges.length - 1];
    if (previous && start <= previous.end + 1) previous.end = end;
    else ranges.push({ start, end });
  }
  const rows = [];
  for (const range of ranges) {
    if (rows.length) rows.push({ type: 'gap' });
    for (let index = range.start; index <= range.end; index++) rows.push(operations[index]);
  }
  if (rows.length > MAX_DIFF_LINES * 4) {
    return { kind: 'large', message: 'Inline diff skipped because it contains too many separate changes.' };
  }
  return { kind: 'text', added, removed, rows };
}

async function diffFile(path) {
  path = repoPath(path);
  const matrix = await git.statusMatrix({ fs, dir: REPO_DIR });
  const entry = matrix.find(([entryPath]) => entryPath === path);
  if (!entry || (entry[1] === entry[2] && entry[1] === entry[3])) {
    return { path, kind: 'unchanged', message: 'This file has no current worktree diff.' };
  }
  const [, head, workdir] = entry;
  const headSha = await git.resolveRef({ fs, dir: REPO_DIR, ref: 'HEAD' });
  const before = head === 0
    ? new Uint8Array()
    : (await git.readBlob({ fs, dir: REPO_DIR, oid: headSha, filepath: path })).blob;
  const after = workdir === 0 ? new Uint8Array() : await pfs.readFile(`${REPO_DIR}/${path}`);
  const sizes = { oldSize: before.byteLength, newSize: after.byteLength };
  if (sizes.oldSize > MAX_INLINE_DIFF_BYTES || sizes.newSize > MAX_INLINE_DIFF_BYTES) {
    return { path, kind: 'large', ...sizes, message: 'Inline diff skipped because this file exceeds the 256 KB preview limit.' };
  }
  const beforeText = decodeDiffText(before);
  const afterText = decodeDiffText(after);
  if (beforeText === null || afterText === null) {
    return { path, kind: 'binary', ...sizes, message: 'Binary file changed; inline text diff is unavailable.' };
  }
  return { path, ...sizes, ...diffLines(beforeText, afterText) };
}
 

async function metadata() {
  const branch = await git.currentBranch({ fs, dir: REPO_DIR, fullname: false });
  const headSha = await git.resolveRef({ fs, dir: REPO_DIR, ref: 'HEAD' });
  let isStale = false;
  if (publishedSnapshot) {
    if (branch !== publishedSnapshot.branch) {
      isStale = true;
    } else if (snapshot.baseSha !== publishedSnapshot.baseSha) {
      try {
        isStale = !(await git.isDescendent({ fs, dir: REPO_DIR, oid: headSha, ancestor: publishedSnapshot.baseSha }));
      } catch {
        isStale = true;
      }
    }
  }
  const origin = await git.getConfig({ fs, dir: REPO_DIR, path: 'remote.origin.url' });
  const upstreamSnapshot = publishedSnapshot || snapshot;
  return {
    ...snapshot,
    branch: branch || snapshot.branch,
    headSha,
    upstreamSha: upstreamSnapshot.baseSha,
    upstreamBranch: upstreamSnapshot.branch,
    upstreamBuiltAt: upstreamSnapshot.builtAt,
    archiveEncryption: upstreamSnapshot.archiveEncryption || 'none',
    staleBase: Boolean(isStale),
    githubTarget: parseGitHubOrigin(origin),
  };
}

function parseGitHubOrigin(origin) {
  if (typeof origin !== 'string') return null;
  const match = origin.match(/^(?:https:\/\/github\.com\/|git@github\.com:)([^/]+)\/([^/]+?)(?:\.git)?$/i);
  if (!match || match[1] === '.' || match[1] === '..' || match[2] === '.' || match[2] === '..') return null;
  return { owner: match[1], repo: match[2] };
}

async function readFile(path) {
  path = repoPath(path);
  const bytes = await pfs.readFile(`${REPO_DIR}/${path}`);
  let text = null;
  if (!bytes.includes(0)) {
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { /* Binary data is returned unchanged. */ }
  }
  return { path, size: bytes.byteLength, isText: text !== null, text, bytes: text === null ? bytes : null };
}

async function writeFile(path, contents) {
  path = repoPath(path);
  const bytes = typeof contents === 'string' ? contents : new Uint8Array(contents);
  const absolute = `${REPO_DIR}/${path}`;
  await mkdirp(absolute.slice(0, absolute.lastIndexOf('/')));
  let mode;
  try {
    const stat = await pfs.lstat(absolute);
    if (stat.isFile()) mode = stat.mode & 0o777;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  await pfs.writeFile(absolute, bytes, mode === undefined ? {} : { mode });
  await pfs.flush();
  return { path, size: bytes.byteLength };
}

async function removeFile(path) {
  path = repoPath(path);
  await pfs.unlink(`${REPO_DIR}/${path}`);
  await pfs.flush();
  return { path };
}

async function renameFile(from, to) {
  from = repoPath(from);
  to = repoPath(to);
  const target = `${REPO_DIR}/${to}`;
  if (from !== to) {
    try {
      await pfs.lstat(target);
      throw new Error(`The destination already exists: ${to}`);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  await mkdirp(target.slice(0, target.lastIndexOf('/')));
  await pfs.rename(`${REPO_DIR}/${from}`, target);
  await pfs.flush();
  return { from, to };
}

async function log() {
  const entries = await git.log({ fs, dir: REPO_DIR });
  return entries.map(({ oid, commit }) => ({
    oid,
    message: commit.message.trim(),
    author: commit.author.name,
    email: commit.author.email,
    timestamp: commit.author.timestamp,
  }));
}

async function commit({ message, authorName, authorEmail }) {
  const commitMessage = String(message || '').trim();
  const name = String(authorName || '').trim();
  const email = String(authorEmail || '').trim();
  if (!commitMessage || !name || !email) throw new Error('Commit message, author name, and author email are required.');
  const matrix = await git.statusMatrix({ fs, dir: REPO_DIR });
  const changed = matrix.filter(([, head, workdir, stage]) => head !== workdir || head !== stage);
  if (!changed.length) throw new Error('There are no changes to commit.');
  for (const [path, head, workdir, stage] of changed) {
    if (workdir === 0 && head !== 0) {
      if (stage !== 0) await git.remove({ fs, dir: REPO_DIR, filepath: path });
    } else if (workdir !== 0) {
      await git.add({ fs, dir: REPO_DIR, filepath: path });
    }
  }
  const oid = await git.commit({
    fs,
    dir: REPO_DIR,
    message: commitMessage,
    author: { name, email },
    committer: { name, email },
  });
  await pfs.flush();
  return { oid, message: commitMessage, author: name, email, timestamp: Math.floor(Date.now() / 1000) };
}

const GITHUB_API_BASE = 'https://api.github.com';
const GITHUB_API_VERSION = '2026-03-10';
const GITHUB_REQUEST_TIMEOUT_MS = 30_000;

function githubApiError(response) {
  const remaining = response.headers.get('x-ratelimit-remaining');
  if (response.status === 429 || response.headers.has('retry-after') || remaining === '0') {
    return new Error('GitHub API rate limit reached. Wait before retrying.');
  }
  if (response.status === 401) return new Error('GitHub rejected the token. Check that the fine-grained PAT is valid and has access to this repository.');
  if (response.status === 403) return new Error('GitHub denied the request. Grant the fine-grained PAT Contents: write access and check any organization or branch policies.');
  if (response.status === 404) return new Error('GitHub could not find the repository or origin branch, or the token cannot access it. Check the origin and current branch.');
  if (response.status === 409) return new Error('GitHub detected a branch conflict. Fetch and reconcile the branch from a console before retrying.');
  if (response.status === 422) return new Error('GitHub rejected the Git object or branch update. Confirm Contents: write permission and check branch protection; use the console workflow if needed.');
  return new Error(`GitHub API request failed with status ${response.status}.`);
}

async function githubRequest({ token, url, method = 'GET', body }) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), GITHUB_REQUEST_TIMEOUT_MS);
  let response;
  try {
    try {
      response = await fetch(url, {
        method,
        cache: 'no-store',
        headers: {
          Accept: 'application/vnd.github+json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          'X-GitHub-Api-Version': GITHUB_API_VERSION,
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: controller.signal,
      });
    } catch {
      if (controller.signal.aborted) throw new Error('GitHub API request timed out. Check connectivity and try again.');
      throw new Error('Could not reach GitHub. Check connectivity and try again.');
    }
    if (!response.ok) throw githubApiError(response);
    try {
      return await response.json();
    } catch {
      if (controller.signal.aborted) throw new Error('GitHub API request timed out. Check connectivity and try again.');
      throw new Error('GitHub returned an unreadable response. Retry, or use the console workflow.');
    }
  } finally {
    clearTimeout(timeout);
  }
}

function githubRepositoryPath({ owner, repo }) {
  return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
}

function encodedBranchPath(branch) {
  return branch.split('/').map((part) => encodeURIComponent(part)).join('/');
}

function githubDate(person) {
  const offset = Number.isFinite(person.timezoneOffset) ? person.timezoneOffset : 0;
  const eastOffset = -offset;
  const date = new Date((person.timestamp - offset * 60) * 1000);
  const pad = (value) => String(value).padStart(2, '0');
  const sign = eastOffset < 0 ? '-' : '+';
  const absoluteOffset = Math.abs(eastOffset);
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}T${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}${sign}${pad(Math.floor(absoluteOffset / 60))}:${pad(absoluteOffset % 60)}`;
}


async function githubPush(payload) {
  let token = payload.token;
  payload.token = '';
  try {
    if (typeof token !== 'string' || !token.trim()) throw new Error('Enter a fine-grained GitHub PAT with Contents: write access to this repository.');
    token = token.trim();

    const origin = await git.getConfig({ fs, dir: REPO_DIR, path: 'remote.origin.url' });
    if (typeof origin !== 'string' || !origin) throw new Error('Configure a GitHub origin before pushing.');
    const target = parseGitHubOrigin(origin);
    if (!target) throw new Error('Only https://github.com/owner/repo[.git] and git@github.com:owner/repo[.git] origins are supported.');

    const matrix = await git.statusMatrix({ fs, dir: REPO_DIR });
    if (matrix.some(([, head, workdir, stage]) => head !== workdir || head !== stage)) {
      throw new Error('Commit or discard all working-tree and staged changes before pushing.');
    }
    const branch = await git.currentBranch({ fs, dir: REPO_DIR, fullname: false });
    if (!branch) throw new Error('Check out a local branch before pushing.');
    const headSha = await git.resolveRef({ fs, dir: REPO_DIR, ref: branch });
    const repositoryPath = githubRepositoryPath(target);
    const branchPath = encodedBranchPath(branch);
    const refUrl = `${GITHUB_API_BASE}${repositoryPath}/git/ref/heads/${branchPath}`;
    const updateRefUrl = `${GITHUB_API_BASE}${repositoryPath}/git/refs/heads/${branchPath}`;
    const remoteRef = await githubRequest({ token, url: refUrl });
    const remoteHead = remoteRef?.object?.sha;
    if (!remoteHead || remoteRef.object.type !== 'commit') {
      throw new Error('The configured GitHub origin branch does not point to a commit. Check the remote branch in a console.');
    }
    if (remoteHead === headSha) {
      return { owner: target.owner, repo: target.repo, branch, pushedCount: 0, remoteHead, upToDate: true };
    }

    const commitsToPush = [];
    const visited = new Set();
    let remoteIsAncestor = false;
    async function visitCommit(oid) {
      if (oid === remoteHead) {
        remoteIsAncestor = true;
        return;
      }
      if (visited.has(oid)) return;
      visited.add(oid);
      let localCommit;
      try {
        localCommit = (await git.readCommit({ fs, dir: REPO_DIR, oid })).commit;
      } catch {
        throw new Error('The GitHub branch is not in this browser repository history. Fetch and reconcile it from a console, then reload.');
      }
      for (const parent of localCommit.parent) await visitCommit(parent);
      commitsToPush.push({ oid, commit: localCommit });
    }
    await visitCommit(headSha);
    if (!remoteIsAncestor) {
      throw new Error('The GitHub origin branch has diverged from or advanced beyond this browser repository. Fetch and reconcile it from a console, then reload.');
    }

    const blobShas = new Map();
    const treeEntries = new Map();
    async function uploadBlob(oid) {
      if (blobShas.has(oid)) return blobShas.get(oid);
      const { blob } = await git.readBlob({ fs, dir: REPO_DIR, oid });
      const result = await githubRequest({
        token,
        url: `${GITHUB_API_BASE}${repositoryPath}/git/blobs`,
        method: 'POST',
        body: { content: Buffer.from(blob).toString('base64'), encoding: 'base64' },
      });
      if (result?.sha !== oid) throw new Error('GitHub changed a local blob object. The branch was not updated; export/push from a console instead.');
      blobShas.set(oid, result.sha);
      return result.sha;
    }
    async function readTreeEntries(oid) {
      if (!oid) return [];
      if (!treeEntries.has(oid)) {
        const { tree } = await git.readTree({ fs, dir: REPO_DIR, oid });
        treeEntries.set(oid, tree);
      }
      return treeEntries.get(oid);
    }
    async function createMatchingTree(targetTree, baseTree) {
      if (targetTree === baseTree) return targetTree;
      const [targetEntries, baseEntries] = await Promise.all([
        readTreeEntries(targetTree),
        readTreeEntries(baseTree),
      ]);
      const targetByPath = new Map(targetEntries.map((entry) => [entry.path, entry]));
      const baseByPath = new Map(baseEntries.map((entry) => [entry.path, entry]));
      const paths = new Set([...targetByPath.keys(), ...baseByPath.keys()]);
      const changes = [];
      for (const path of paths) {
        const next = targetByPath.get(path);
        const previous = baseByPath.get(path);
        if (!next) {
          changes.push({ path, mode: previous.mode, type: previous.type, sha: null });
          continue;
        }
        if (previous && next.oid === previous.oid && next.mode === previous.mode && next.type === previous.type) continue;
        if (next.type === 'tree') {
          const baseSubtree = previous?.type === 'tree' ? previous.oid : null;
          const subtreeSha = await createMatchingTree(next.oid, baseSubtree);
          changes.push({ path, mode: next.mode, type: 'tree', sha: subtreeSha });
        } else {
          const sha = next.type === 'blob' ? await uploadBlob(next.oid) : next.oid;
          changes.push({ path, mode: next.mode, type: next.type, sha });
        }
      }
      const body = { tree: changes };
      if (baseTree) body.base_tree = baseTree;
      const result = await githubRequest({
        token,
        url: `${GITHUB_API_BASE}${repositoryPath}/git/trees`,
        method: 'POST',
        body,
      });
      if (result?.sha !== targetTree) {
        throw new Error('GitHub changed a local tree object. The branch was not updated; export/push from a console instead.');
      }
      return result.sha;
    }

    for (const { oid, commit: localCommit } of commitsToPush) {
      const firstParent = localCommit.parent[0];
      const baseTree = firstParent
        ? (await git.readCommit({ fs, dir: REPO_DIR, oid: firstParent })).commit.tree
        : null;
      const treeSha = await createMatchingTree(localCommit.tree, baseTree);
      if (treeSha !== localCommit.tree) {
        throw new Error('GitHub changed a local tree object. The branch was not updated; export/push from a console instead.');
      }
      const result = await githubRequest({
        token,
        url: `${GITHUB_API_BASE}${repositoryPath}/git/commits`,
        method: 'POST',
        body: {
          message: localCommit.message,
          tree: treeSha,
          parents: localCommit.parent,
          author: {
            name: localCommit.author.name,
            email: localCommit.author.email,
            date: githubDate(localCommit.author),
          },
          committer: {
            name: localCommit.committer.name,
            email: localCommit.committer.email,
            date: githubDate(localCommit.committer),
          },
        },
      });
      if (result?.sha !== oid) {
        throw new Error('GitHub changed a local commit object. The branch was not updated; export/push from a console instead.');
      }
    }

    await githubRequest({
      token,
      url: updateRefUrl,
      method: 'PATCH',
      body: { sha: headSha, force: false },
    });
    return {
      owner: target.owner,
      repo: target.repo,
      branch,
      pushedCount: commitsToPush.length,
      remoteHead: headSha,
      upToDate: false,
    };
  } finally {
    token = '';
    payload.token = '';
  }
}


async function resetPublishedSnapshot(payload) {
  if (payload.confirmation !== true) throw new Error('Confirm that you want to replace this browser workspace.');
  await fs.init(FS_NAME);

  const previousSnapshot = snapshot;
  const previousPublishedSnapshot = publishedSnapshot;
  const previousInitialized = initialized;
  let previousReady;
  try { previousReady = await pfs.readFile(READY_FILE, 'utf8'); } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  if (!await pathExists(REPO_DIR) && await pathExists(RESET_BACKUP_DIR)) {
    await pfs.rename(RESET_BACKUP_DIR, REPO_DIR);
  }

  let movedOldRepository = false;
  let installedSnapshot = false;
  try {
    await removeTree(RESET_STAGING_DIR);
    const { published, archive, metadata } = await fetchPublishedArchive(payload.baseUrl, payload.encryptionKeyHex);
    await materializeSnapshot(RESET_STAGING_DIR, archive, metadata);
    await pfs.flush();
    if (await pathExists(RESET_BACKUP_DIR)) await removeTree(RESET_BACKUP_DIR);
    if (await pathExists(REPO_DIR)) {
      await pfs.rename(REPO_DIR, RESET_BACKUP_DIR);
      movedOldRepository = true;
    }
    await pfs.rename(RESET_STAGING_DIR, REPO_DIR);
    installedSnapshot = true;
    const nextSnapshot = {
      snapshotVersion: metadata.snapshotVersion,
      baseSha: metadata.baseSha,
      branch: metadata.branch,
      builtAt: metadata.builtAt,
      archiveEncryption: metadata.archiveEncryption || 'none',
    };
    await mkdirp(WORKSPACE_DIR);
    await pfs.writeFile(READY_FILE, JSON.stringify(nextSnapshot), 'utf8');
    await pfs.flush();
    if (await pathExists(INITIALIZATION_FILE)) await pfs.unlink(INITIALIZATION_FILE);
    await pfs.flush();
    snapshot = nextSnapshot;
    publishedSnapshot = published;
    initialized = Promise.resolve();

    let cleanupWarning = false;
    if (movedOldRepository) {
      try {
        await removeTree(RESET_BACKUP_DIR);
        await pfs.flush();
      } catch {
        cleanupWarning = true;
      }
    }
    return { branch: metadata.branch, baseSha: metadata.baseSha, cleanupWarning };
  } catch (error) {
    try {
      if (installedSnapshot) await removeTree(REPO_DIR);
      if (movedOldRepository && await pathExists(RESET_BACKUP_DIR)) await pfs.rename(RESET_BACKUP_DIR, REPO_DIR);
      if (previousReady === undefined) {
        if (await pathExists(READY_FILE)) await pfs.unlink(READY_FILE);
      } else {
        await mkdirp(WORKSPACE_DIR);
        await pfs.writeFile(READY_FILE, previousReady, 'utf8');
      }
      await pfs.flush();
      snapshot = previousSnapshot;
      publishedSnapshot = previousPublishedSnapshot;
      initialized = previousInitialized;
    } catch (rollbackError) {
      throw new Error(`${error instanceof Error ? error.message : String(error)} The previous workspace could not be fully restored: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`);
    }
    throw error;
  } finally {
    try {
      await removeTree(RESET_STAGING_DIR);
      await pfs.flush();
    } catch { /* A later reset retries cleanup of this private staging path. */ }
  }
}


async function exportPreviewFiles() {
  const files = Object.create(null);
  async function visit(directory) {
    for (const name of await pfs.readdir(directory)) {
      const fullPath = `${directory}/${name}`;
      const relative = fullPath.slice(REPO_DIR.length + 1);
      if (isExcludedPreviewPath(relative)) continue;
      const stat = await pfs.lstat(fullPath);
      if (stat.isDirectory()) {
        await visit(fullPath);
      } else if (stat.isSymbolicLink()) {
        const target = await pfs.readlink(fullPath);
        if (isSafePreviewSymlink(relative, target)) Object.defineProperty(files, relative, { value: { symlink: target }, enumerable: true });
      } else if (stat.isFile()) {
        Object.defineProperty(files, relative, { value: await pfs.readFile(fullPath), enumerable: true });
      }
    }
  }
  await visit(REPO_DIR);
  return files;
}

async function exportRepository() {
  const zipEntries = {};
  async function visit(directory) {
    for (const name of await pfs.readdir(directory)) {
      const fullPath = `${directory}/${name}`;
      const stat = await pfs.lstat(fullPath);
      if (stat.isDirectory()) {
        await visit(fullPath);
      } else if (stat.isFile() || stat.isSymbolicLink()) {
        const relative = fullPath.slice(REPO_DIR.length + 1);
        const symlink = stat.isSymbolicLink();
        const contents = symlink
          ? new TextEncoder().encode(await pfs.readlink(fullPath))
          : await pfs.readFile(fullPath);
        const permissions = stat.mode & 0o777;
        const mode = symlink ? 0o120777 : 0o100000 | permissions;
        zipEntries[relative] = [contents, { os: 3, attrs: mode * 65536 }];
      }
    }
  }
  await visit(REPO_DIR);
  await pfs.flush();
  return zipSync(zipEntries, { level: 0 });
}

async function handle(type, payload) {
  if (type !== 'init' && type !== 'reset-published') await ensureInitialized(payload.baseUrl, payload.encryptionKeyHex);
  switch (type) {
    case 'init':
      await ensureInitialized(payload.baseUrl, payload.encryptionKeyHex);
      return { metadata: await metadata(), files: await listFiles(), status: await status(), log: await log() };
    case 'list': return listFiles();
    case 'read': return readFile(payload.path);
    case 'write': return writeFile(payload.path, payload.contents);
    case 'remove': return removeFile(payload.path);
    case 'rename': return renameFile(payload.from, payload.to);
    case 'status': return status();
    case 'diff': return diffFile(payload.path);
    case 'log': return log();
    case 'metadata': return metadata();
    case 'commit': return commit(payload);
    case 'github-push': return githubPush(payload);
    case 'reset-published': return resetPublishedSnapshot(payload);
    case 'preview-files': return exportPreviewFiles();
    case 'export': return exportRepository();
    default: throw new Error(`Unknown repository operation: ${type}`);
  }
}

self.addEventListener('message', (event) => {
  const { id, type, payload = {} } = event.data;
  queue = queue.then(() => handle(type, payload)).then((result) => {
    const transfer = result instanceof Uint8Array ? [result.buffer] : [];
    self.postMessage({ id, result }, transfer);
  }).catch((error) => {
    self.postMessage({ id, error: error?.message || String(error) });
  });
});
