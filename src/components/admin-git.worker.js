import git from 'isomorphic-git';
import LightningFS from '@isomorphic-git/lightning-fs';
import { unzipSync, zipSync } from 'fflate';
import { Buffer } from 'buffer';
globalThis.Buffer = Buffer;

const FS_NAME = 'astro-cms-admin-repository';
const REPO_DIR = '/repo';
const WORKSPACE_DIR = '/workspace-meta';
const READY_FILE = `${WORKSPACE_DIR}/initialized.json`;
const fs = new LightningFS();
const pfs = fs.promises;
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

async function comparePublishedSnapshot(baseUrl) {
  publishedSnapshot = null;
  const sidecarUrl = new URL('admin/snapshot.json', new URL(baseUrl, self.location.origin));
  let response;
  try { response = await fetch(sidecarUrl, { cache: 'no-cache' }); } catch { return; }
  if (!response.ok) return;
  const latest = await response.json();
  if (latest?.snapshotVersion !== 1) {
    throw new Error(`Unsupported repository snapshot version: ${latest?.snapshotVersion ?? 'missing'}.`);
  }
  if (!latest.baseSha || !latest.branch) throw new Error('The published snapshot metadata is missing its branch or base commit.');
  publishedSnapshot = latest;
}

async function ensureInitialized(baseUrl) {
  if (initialized) return initialized;
  initialized = (async () => {
    await fs.init(FS_NAME);

    let saved;
    try {
      saved = await pfs.readFile(READY_FILE, 'utf8');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
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
      throw new Error('Repository data exists without its initialization marker. Refusing to overwrite it; export the repository or clear this browser workspace manually.');
    }

    await mkdirp(REPO_DIR);
    const archiveUrl = new URL('admin/base-git.zip', new URL(baseUrl, self.location.origin));
    const response = await fetch(archiveUrl);
    if (!response.ok) throw new Error(`Could not load the repository snapshot (${response.status}).`);
    const archive = unzipSync(new Uint8Array(await response.arrayBuffer()));
    const metadataBytes = archive['snapshot.json'];
    if (!metadataBytes) throw new Error('The repository archive is missing snapshot.json.');
    const metadata = JSON.parse(new TextDecoder().decode(metadataBytes));
    if (metadata?.snapshotVersion !== 1) {
      throw new Error(`Unsupported repository snapshot version: ${metadata?.snapshotVersion ?? 'missing'}.`);
    }
    if (!metadata.branch || !metadata.baseSha) throw new Error('The repository snapshot is missing its branch or base commit.');
    if (publishedSnapshot && (metadata.baseSha !== publishedSnapshot.baseSha || metadata.branch !== publishedSnapshot.branch)) {
      throw new Error('The repository ZIP does not match the published snapshot metadata. Reload and try again.');
    }

    let gitEntries = 0;
    for (const [entryName, contents] of Object.entries(archive)) {
      const safeName = zipPath(entryName);
      if (!safeName || safeName.endsWith('/') || !safeName.startsWith('.git/')) continue;
      const relative = safeName.slice('.git/'.length);
      if (!relative) continue;
      const path = `${REPO_DIR}/.git/${relative}`;
      await mkdirp(path.slice(0, path.lastIndexOf('/')));
      await pfs.writeFile(path, contents);
      gitEntries++;
    }
    if (!gitEntries) throw new Error('The repository archive does not contain a Git database.');

    await git.checkout({ fs, dir: REPO_DIR, ref: metadata.branch, force: true });
    await pfs.flush();
    const checkedOutHead = await git.resolveRef({ fs, dir: REPO_DIR, ref: 'HEAD' });
    if (checkedOutHead !== metadata.baseSha) {
      throw new Error('The snapshot branch does not point at its declared base commit.');
    }
    snapshot = {
      snapshotVersion: metadata.snapshotVersion,
      baseSha: metadata.baseSha,
      branch: metadata.branch,
      builtAt: metadata.builtAt,
    };
    await mkdirp(WORKSPACE_DIR);
    await pfs.writeFile(READY_FILE, JSON.stringify(snapshot), 'utf8');
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

async function metadata() {
  const branch = await git.currentBranch({ fs, dir: REPO_DIR, fullname: false });
  const headSha = await git.resolveRef({ fs, dir: REPO_DIR, ref: 'HEAD' });
  const isStale = publishedSnapshot && (snapshot.baseSha !== publishedSnapshot.baseSha || snapshot.branch !== publishedSnapshot.branch);
  const origin = await git.getConfig({ fs, dir: REPO_DIR, path: 'remote.origin.url' });
  return {
    ...snapshot,
    branch: branch || snapshot.branch,
    headSha,
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
    return new Error('GitHub API rate limit reached. Wait before retrying the push.');
  }
  if (response.status === 401) return new Error('GitHub rejected the token. Check that the fine-grained PAT is valid and has access to this repository.');
  if (response.status === 403) return new Error('GitHub denied the request. Grant the fine-grained PAT Contents: write access to this repository and check any organization or branch policies.');
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
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${token}`,
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
  if (type !== 'init') await ensureInitialized(payload.baseUrl);
  switch (type) {
    case 'init':
      await ensureInitialized(payload.baseUrl);
      return { metadata: await metadata(), files: await listFiles(), status: await status(), log: await log() };
    case 'list': return listFiles();
    case 'read': return readFile(payload.path);
    case 'write': return writeFile(payload.path, payload.contents);
    case 'remove': return removeFile(payload.path);
    case 'rename': return renameFile(payload.from, payload.to);
    case 'status': return status();
    case 'log': return log();
    case 'metadata': return metadata();
    case 'commit': return commit(payload);
    case 'github-push': return githubPush(payload);
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
