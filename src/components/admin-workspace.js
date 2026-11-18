const categoryNames = { menus: 'Menus', blog: 'Blog posts', content: 'Content' };
const screens = [...document.querySelectorAll('[data-screen]')];
const navItems = [...document.querySelectorAll('.nav-item[data-view]')];
const editor = document.querySelector('[data-text-editor]');
const lineGutter = document.querySelector('[data-line-gutter]');
const textPanel = document.querySelector('[data-text-panel]');
const markdownPanel = document.querySelector('[data-markdown-panel]');
const markdownMount = document.querySelector('[data-markdown-editor]');
const markdownToggle = document.querySelector('[data-action="toggle-markdown-mode"]');
const markdownFrontmatterNote = document.querySelector('[data-markdown-frontmatter-note]');
const toast = document.querySelector('[data-toast]');
const worker = new Worker(new URL('./admin-git.worker.js', import.meta.url), { type: 'module' });
const pending = new Map();
const BASE_URL = import.meta.env.BASE_URL.endsWith('/') ? import.meta.env.BASE_URL : `${import.meta.env.BASE_URL}/`;
const COMMIT_AUTHOR_COOKIE = 'astraeuscms_commit_author';
const COMMIT_AUTHOR_COOKIE_MAX_AGE = 60 * 60 * 24 * 365;
const UPSTREAM_STATE_STORAGE_KEY = 'astraeuscms_last_known_upstream';
let requestId = 0;
let toastTimer;
let files = [];
let statuses = [];
let commits = [];
let repository = null;
let currentView = 'overview';
let category = 'menus';
let selectedPath = '';
let editorBaselineText = '';
let isTextFile = false;
let isMarkdownFile = false;
let markdownEditor = null;
let markdownModulePromise = null;
let markdownEditorInitialization = null;
let markdownEditorGeneration = 0;
let fileOpenGeneration = 0;
let markdownEditorMode = 'source';
let markdownFrontmatter = '';
let markdownBodySuffix = '';
let markdownLineEnding = '\n';
let markdownVisualEdited = false;
let markdownSettingData = false;
let imageUrl = '';
let fileFilter = '';
let githubPushInProgress = false;
let resetInProgress = false;

worker.addEventListener('message', ({ data }) => {
  const request = pending.get(data.id);
  if (!request) return;
  pending.delete(data.id);
  if (data.error) request.reject(new Error(data.error));
  else request.resolve(data.result);
});
worker.addEventListener('error', (event) => {
  for (const request of pending.values()) request.reject(new Error(event.message || 'The repository worker stopped unexpectedly.'));
  pending.clear();
});

function callWorker(type, payload = {}, transfer = []) {
  const id = ++requestId;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    worker.postMessage({ id, type, payload: { baseUrl: BASE_URL, ...payload } }, transfer);
  });
}

function showToast(message) {
  if (!toast) return;
  toast.textContent = message;
  toast.hidden = false;
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => { toast.hidden = true; }, 4200);
}

function setText(selector, value) {
  const element = document.querySelector(selector);
  if (element) element.textContent = value;
}

function showScreen(name, activeView = name) {
  screens.forEach((screen) => { screen.hidden = screen.dataset.screen !== name; });
  navItems.forEach((item) => {
    const active = item.dataset.view === activeView;
    item.classList.toggle('is-active', active);
    if (active) item.setAttribute('aria-current', 'page');
    else item.removeAttribute('aria-current');
  });
  const crumb = document.querySelector('[data-breadcrumb]');
  if (crumb) crumb.textContent = name === 'editor' ? (activeView === 'files' ? 'Files' : categoryNames[category]) : name === 'commits' ? 'Git' : 'Overview';
  currentView = activeView;
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function kindFor(path) {
  if (path.startsWith('src/data/menus/')) return 'menus';
  if (path.startsWith('src/content/blog/')) return 'blog';
  if (path.startsWith('src/content/pages/')) return 'content';
  return '';
}

function statusFor(path) {
  const item = statuses.find((entry) => entry.path === path);
  if (!item) return 'Untracked';
  if (item.head === 0 && item.workdir !== 0) return 'Untracked';
  if (item.workdir === 0 && item.head !== 0) return 'Deleted';
  if (item.stage !== item.head && item.workdir !== item.stage) return 'Staged + modified';
  if (item.stage !== item.head) return 'Staged';
  if (item.workdir !== item.stage) return 'Modified';
  return 'Tracked';
}

function statusText(path) {
  const status = statusFor(path);
  return status === 'Tracked' ? 'Tracked in HEAD' : status;
}

function knownUpstreamState() {
  const baseline = {
    sha: repository?.upstreamSha || repository?.baseSha || '',
    branch: repository?.upstreamBranch || repository?.branch || '',
    builtAt: Date.parse(repository?.upstreamBuiltAt || repository?.builtAt || '') || 0,
  };
  const target = repository?.githubTarget;
  if (!target?.owner || !target.repo || !baseline.sha || !baseline.branch) {
    return { ...baseline, known: false };
  }
  try {
    const stored = JSON.parse(window.localStorage.getItem(UPSTREAM_STATE_STORAGE_KEY) || 'null');
    if (stored?.owner === target.owner && stored.repo === target.repo && stored.branch === repository.branch
      && /^[0-9a-f]{40}$/i.test(stored.sha) && Number.isFinite(stored.checkedAt) && stored.checkedAt >= baseline.builtAt) {
      return { sha: stored.sha, branch: stored.branch, known: true };
    }
  } catch {}
  return { ...baseline, known: true };
}

function hasUncommittedChanges() {
  const changedFiles = statuses.some(({ path }) => statusFor(path) !== 'Tracked');
  const unsavedEditorText = Boolean(editor && selectedPath && isTextFile && editor.value !== editorBaselineText);
  return changedFiles || unsavedEditorText;
}

function updateSidebarStatus() {
  const indicator = document.querySelector('[data-workspace-indicator]');
  const status = document.querySelector('[data-sidebar-state]');
  if (!indicator || !status) return;
  if (!repository) {
    indicator.dataset.state = 'unknown';
    return;
  }
  const uncommitted = hasUncommittedChanges();
  const upstream = knownUpstreamState();
  const outOfSync = upstream.known
    && (repository.branch !== upstream.branch || repository.headSha !== upstream.sha);
  if (uncommitted) {
    indicator.dataset.state = 'dirty';
    status.textContent = outOfSync ? 'Uncommitted changes · upstream differs' : 'Uncommitted changes';
  } else if (!upstream.known) {
    indicator.dataset.state = 'unknown';
    status.textContent = 'Upstream status unknown';
  } else if (outOfSync) {
    indicator.dataset.state = 'out-of-sync';
    status.textContent = 'Not in sync with upstream';
  } else {
    indicator.dataset.state = 'synced';
    status.textContent = 'In sync with upstream';
  }
}

function rememberPushedUpstream(result) {
  if (!result?.owner || !result.repo || !result.branch || !/^[0-9a-f]{40}$/i.test(result.remoteHead || '')) return;
  try {
    window.localStorage.setItem(UPSTREAM_STATE_STORAGE_KEY, JSON.stringify({
      owner: result.owner,
      repo: result.repo,
      branch: result.branch,
      sha: result.remoteHead,
      checkedAt: Date.now(),
    }));
  } catch {}
  updateSidebarStatus();
}

function markFor(path) {
  if (/\.ya?ml$/i.test(path)) return ['Y', 'yaml-mark'];
  if (/\.(md|mdx|txt|astro|html|css|js|mjs|ts|json|toml|xml|svg)$/i.test(path)) return ['T', 'markdown-mark'];
  if (/\.(png|jpe?g|gif|webp|avif|bmp|ico)$/i.test(path)) return ['I', 'markdown-mark'];
  return ['F', 'markdown-mark'];
}

function updateLineNumbers() {
  if (!editor || !lineGutter) return;
  const count = Math.max(1, editor.value.split('\n').length);
  lineGutter.textContent = Array.from({ length: count }, (_, index) => String(index + 1)).join('\n');
}

function currentStatusLine() {
  if (!selectedPath) return 'Select a repository file';
  if (editor && isTextFile && editor.value !== editorBaselineText) return 'Unsaved editor changes';
  return statusText(selectedPath);
}

function updateEditorState() {
  const changed = Boolean(editor && isTextFile && selectedPath && editor.value !== editorBaselineText);
  const dot = document.querySelector('[data-dirty-indicator]');
  const status = document.querySelector('[data-editor-status]');
  const saveButton = document.querySelector('[data-action="save"]');
  if (dot) dot.hidden = !changed;
  if (status) status.textContent = currentStatusLine();
  if (saveButton) {
    saveButton.disabled = !selectedPath || !isTextFile;
    saveButton.textContent = changed ? 'Save to worktree' : 'Saved';
  }
  document.querySelectorAll('[data-action="rename"], [data-action="delete"]').forEach((button) => { button.disabled = !selectedPath; });
  const downloadButton = document.querySelector('[data-action="download-file"]');
  if (downloadButton) downloadButton.disabled = !selectedPath || isTextFile;
  updateSidebarStatus();
}

function splitMarkdownFrontmatter(source) {
  const match = /^(\uFEFF?---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*)(\r?\n(?:[ \t]*\r?\n)*|$)([\s\S]*)$/.exec(source);
  if (match) return { frontmatter: `${match[1]}${match[2]}`, body: match[3], malformed: false };
  return {
    frontmatter: '',
    body: source,
    malformed: /^\uFEFF?---[ \t]*\r?\n/.test(source),
  };
}

function splitMarkdownBodyEnding(source) {
  const match = /(?:\r?\n)*$/.exec(source);
  return { body: source.slice(0, match.index), suffix: match[0] };
}

function setMarkdownMode(mode) {
  markdownEditorMode = mode;
  const visual = isMarkdownFile && Boolean(markdownEditor) && mode === 'visual';
  if (textPanel) textPanel.hidden = visual;
  if (markdownPanel) markdownPanel.hidden = !visual;
  if (markdownToggle) {
    markdownToggle.hidden = !isMarkdownFile || !markdownEditor;
    markdownToggle.textContent = mode === 'visual' ? 'Source' : 'Visual';
    markdownToggle.setAttribute('aria-label', mode === 'visual' ? 'Switch to source mode' : 'Switch to visual mode');
  }
  if (markdownFrontmatterNote) markdownFrontmatterNote.hidden = !visual || !markdownFrontmatter;
}

function syncMarkdownEditorToSource() {
  if (!editor || !markdownEditor || !isMarkdownFile || markdownEditorMode !== 'visual' || !markdownVisualEdited) return;
  const body = markdownEditor.getData().replace(/\r\n?/g, '\n').replace(/\n+$/, '').replace(/\n/g, markdownLineEnding);
  const source = `${markdownFrontmatter}${body}${markdownBodySuffix}`;
  if (editor.value === source) return;
  editor.value = source;
  updateLineNumbers();
  updateEditorState();
}

async function loadMarkdownEditor() {
  if (!markdownModulePromise) {
    markdownModulePromise = import('./ckeditor-markdown.js').catch((error) => {
      markdownModulePromise = null;
      throw error;
    });
  }
  return markdownModulePromise;
}

async function disposeMarkdownEditor() {
  markdownEditorGeneration++;
  const instance = markdownEditor;
  markdownEditor = null;
  if (instance) await instance.destroy();
  if (markdownEditorInitialization) await markdownEditorInitialization.catch(() => {});
  markdownMount?.replaceChildren();
}

async function createMarkdownEditor(initialData) {
  const generation = ++markdownEditorGeneration;
  const initialization = (async () => {
    const module = await loadMarkdownEditor();
    if (generation !== markdownEditorGeneration || !markdownMount) return false;
    const instance = await module.createMarkdownEditor(markdownMount, initialData);
    if (generation !== markdownEditorGeneration) {
      await instance.destroy();
      return false;
    }
    markdownEditor = instance;
    instance.model.document.on('change:data', () => {
      if (generation !== markdownEditorGeneration || markdownSettingData || markdownEditorMode !== 'visual') return;
      markdownVisualEdited = true;
      syncMarkdownEditorToSource();
    });
    return true;
  })();
  markdownEditorInitialization = initialization;
  try {
    return await initialization;
  } finally {
    if (markdownEditorInitialization === initialization) markdownEditorInitialization = null;
  }
}

function toggleMarkdownMode() {
  if (!isMarkdownFile || !markdownEditor || !editor) return;
  if (markdownEditorMode === 'visual') {
    syncMarkdownEditorToSource();
    markdownVisualEdited = false;
    setMarkdownMode('source');
    editor.focus();
  } else {
    const parsed = splitMarkdownFrontmatter(editor.value);
    if (parsed.malformed) {
      showToast('Cannot switch to visual mode: the Astro frontmatter block is not closed. Fix it in source mode.');
      return;
    }
    markdownSettingData = true;
    try {
      const parsedBody = splitMarkdownBodyEnding(parsed.body);
      markdownBodySuffix = parsedBody.suffix;
      markdownLineEnding = editor.value.includes('\r\n') ? '\r\n' : '\n';
      markdownEditor.setData(parsedBody.body);
    } catch (error) {
      showToast(`Could not switch to visual mode: ${error.message}`);
      return;
    } finally {
      markdownSettingData = false;
    }
    markdownFrontmatter = parsed.frontmatter;
    markdownVisualEdited = false;
    setMarkdownMode('visual');
    markdownEditor.editing.view.focus();
  }
  updateLineNumbers();
  updateEditorState();
}

function renderFileList() {
  const list = document.querySelector('[data-file-list]');
  if (!list) return;
  const search = fileFilter.toLowerCase();
  const visibleFiles = files.filter(({ path }) => {
    const belongs = currentView === 'files' || kindFor(path) === category;
    return belongs && (!search || path.toLowerCase().includes(search));
  });
  list.replaceChildren();
  for (const file of visibleFiles) {
    const [label, markClass] = markFor(file.path);
    const row = document.createElement('button');
    row.className = 'file-row';
    row.type = 'button';
    row.setAttribute('role', 'option');
    row.setAttribute('aria-selected', String(file.path === selectedPath));
    row.classList.toggle('is-selected', file.path === selectedPath);
    row.dataset.file = file.path;
    const mark = document.createElement('span');
    mark.className = `file-mark ${markClass}`;
    mark.textContent = label;
    const copy = document.createElement('span');
    copy.className = 'file-row-copy';
    const name = document.createElement('strong');
    name.textContent = file.path.split('/').at(-1);
    const info = document.createElement('small');
    const status = statusFor(file.path);
    info.textContent = status === 'Tracked' ? file.path : `${file.path} · ${status}`;
    copy.append(name, info);
    row.append(mark, copy);
    list.append(row);
  }
  const countLabel = `${visibleFiles.length} file${visibleFiles.length === 1 ? '' : 's'}`;
  setText('[data-visible-count]', countLabel);
  setText('[data-list-state]', statuses.some((item) => statusFor(item.path) !== 'Tracked') ? 'Worktree changes' : 'Local worktree');
  const categories = ['menus', 'blog', 'content'];
  for (const kind of categories) {
    const count = files.filter(({ path }) => kindFor(path) === kind).length;
    setText(`[data-category-count="${kind}"]`, String(count));
    setText(`[data-category-nav-count="${kind}"]`, String(count));
  }
}

function imageMime(path) {
  const ext = path.split('.').at(-1).toLowerCase();
  return ({ png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif', bmp: 'image/bmp', ico: 'image/x-icon', svg: 'image/svg+xml' })[ext] || 'application/octet-stream';
}

function revokeImageUrl() {
  if (imageUrl) URL.revokeObjectURL(imageUrl);
  imageUrl = '';
}

async function clearSelectedFile() {
  fileOpenGeneration++;
  await disposeMarkdownEditor();
  revokeImageUrl();
  selectedPath = '';
  editorBaselineText = '';
  isTextFile = false;
  isMarkdownFile = false;
  markdownFrontmatter = '';
  markdownVisualEdited = false;
  markdownBodySuffix = '';
  markdownLineEnding = '\n';
  setMarkdownMode('source');
  if (editor) { editor.value = ''; editor.disabled = true; }
  if (textPanel) textPanel.hidden = false;
  if (markdownPanel) markdownPanel.hidden = true;
  if (markdownFrontmatterNote) markdownFrontmatterNote.hidden = true;
  document.querySelector('[data-binary-panel]').hidden = true;
  document.querySelector('[data-image-preview]').hidden = true;
  setText('[data-editor-filename]', 'Select a file');
  setText('[data-editor-path]', '');
  setText('[data-editor-mark]', 'F');
  setText('[data-language]', '—');
  updateLineNumbers();
  updateEditorState();
  renderFileList();
}

async function mayLeaveCurrentFile() {
  syncMarkdownEditorToSource();
  if (!selectedPath || !editor || !isTextFile || editor.value === editorBaselineText) return true;
  if (!window.confirm('Save your unsaved editor changes before continuing? Choose Cancel to stay on this file.')) return false;
  await saveSelected();
  return true;
}

async function openFile(path) {
  if (path === selectedPath) return;
  if (!(await mayLeaveCurrentFile())) return;
  const generation = ++fileOpenGeneration;
  try {
    const result = await callWorker('read', { path });
    if (generation !== fileOpenGeneration) return;
    await disposeMarkdownEditor();
    if (generation !== fileOpenGeneration) return;
    revokeImageUrl();
    selectedPath = result.path;
    isTextFile = result.isText;
    isMarkdownFile = result.isText && /\.(md|markdown)$/i.test(result.path);
    markdownFrontmatter = '';
    markdownVisualEdited = false;
    markdownBodySuffix = '';
    markdownLineEnding = result.text.includes('\r\n') ? '\r\n' : '\n';
    setMarkdownMode('source');
    const filename = path.split('/').at(-1);
    const [markValue, markClass] = markFor(path);
    const mark = document.querySelector('[data-editor-mark]');
    setText('[data-editor-filename]', filename);
    setText('[data-editor-path]', path);
    if (mark) { mark.textContent = markValue; mark.className = `file-mark ${markClass}`; }
    const extension = path.split('.').at(-1).toUpperCase();
    setText('[data-language]', result.isText ? (isMarkdownFile ? 'Markdown · GFM' : (extension || 'TEXT')) : 'BINARY');
    if (result.isText) {
      if (textPanel) textPanel.hidden = false;
      if (markdownPanel) markdownPanel.hidden = true;
      document.querySelector('[data-binary-panel]').hidden = true;
      if (editor) { editor.disabled = false; editor.value = result.text; }
      editorBaselineText = editor?.value || '';
      if (isMarkdownFile) {
        const parsed = splitMarkdownFrontmatter(result.text);
        if (parsed.malformed) {
          showToast('This Markdown file has an unclosed Astro frontmatter block; source editing remains available.');
        } else {
          markdownFrontmatter = parsed.frontmatter;
          const parsedBody = splitMarkdownBodyEnding(parsed.body);
          markdownBodySuffix = parsedBody.suffix;
          markdownLineEnding = result.text.includes('\r\n') ? '\r\n' : '\n';
          if (markdownPanel) markdownPanel.hidden = false;
          if (textPanel) textPanel.hidden = true;
          try {
            const created = await createMarkdownEditor(parsedBody.body);
            if (generation !== fileOpenGeneration || selectedPath !== result.path || !created) return;
            setMarkdownMode('visual');
          } catch (error) {
            if (generation !== fileOpenGeneration) return;
            setMarkdownMode('source');
            showToast(`Visual Markdown editor unavailable; source mode remains available: ${error.message}`);
          }
        }
      }
    } else {
      if (editor) { editor.value = ''; editor.disabled = true; }
      editorBaselineText = '';
      if (textPanel) textPanel.hidden = true;
      if (markdownPanel) markdownPanel.hidden = true;
      document.querySelector('[data-binary-panel]').hidden = false;
      const image = document.querySelector('[data-image-preview]');
      const message = document.querySelector('[data-binary-message]');
      const bytes = result.bytes instanceof Uint8Array ? result.bytes : new Uint8Array(result.bytes);
      if (/\.(png|jpe?g|gif|webp|avif|bmp|ico|svg)$/i.test(path)) {
        imageUrl = URL.createObjectURL(new Blob([bytes], { type: imageMime(path) }));
        image.src = imageUrl;
        image.hidden = false;
        message.textContent = `${result.size.toLocaleString()} bytes · image preview`;
      } else {
        image.hidden = true;
        image.removeAttribute('src');
        message.textContent = `Binary file · ${result.size.toLocaleString()} bytes. Download or replace this asset.`;
      }
    }
    updateLineNumbers();
    updateEditorState();
    renderFileList();
  } catch (error) {
    if (generation === fileOpenGeneration) showToast(`Could not open file: ${error.message}`);
  }
}

async function saveSelected() {
  syncMarkdownEditorToSource();
  if (!selectedPath || !editor || !isTextFile || editor.value === editorBaselineText) return;
  await callWorker('write', { path: selectedPath, contents: editor.value });
  editorBaselineText = editor.value;
  markdownVisualEdited = false;
  await refreshRepository();
  updateEditorState();
  showToast('Saved to the local repository worktree.');
}

function renderRecentFiles() {
  const container = document.querySelector('[data-recent-files]');
  if (!container) return;
  const recent = files.filter(({ path }) => /\.(md|mdx|txt|ya?ml|astro|html|css|js|mjs|ts|json|toml)$/i.test(path)).slice(0, 3);
  container.replaceChildren();
  if (!recent.length) {
    const empty = document.createElement('p');
    empty.className = 'subheading';
    empty.textContent = 'No text files found in this repository.';
    container.append(empty);
    return;
  }
  for (const { path } of recent) {
    const [markText, markClass] = markFor(path);
    const row = document.createElement('button');
    row.className = 'recent-file';
    row.type = 'button';
    row.dataset.openFile = path;
    const mark = document.createElement('span');
    mark.className = `file-mark ${markClass}`;
    mark.textContent = markText;
    const label = document.createElement('span');
    const name = document.createElement('strong');
    name.textContent = path.split('/').at(-1);
    const location = document.createElement('small');
    location.textContent = path;
    label.append(name, location);
    const state = document.createElement('span');
    state.className = 'recent-time';
    state.textContent = statusFor(path);
    row.append(mark, label, state);
    container.append(row);
  }
}

function renderMetadata() {
  if (!repository) return;
  const { branch, baseSha, builtAt, headSha } = repository;
  const shortBase = baseSha ? baseSha.slice(0, 12) : '—';
  setText('[data-sidebar-branch]', branch || 'Detached HEAD');
  setText('[data-sidebar-sha]', shortBase);
  const encryptionIcon = document.querySelector('[data-snapshot-encryption]');
  if (encryptionIcon) {
    const encrypted = repository.archiveEncryption === 'aes-256-gcm';
    const label = encrypted ? 'Snapshot ZIP is encrypted' : 'Snapshot ZIP is not encrypted';
    encryptionIcon.textContent = encrypted ? '🔒' : '🔓';
    encryptionIcon.title = label;
    encryptionIcon.setAttribute('aria-label', label);
  }
  setText('[data-overview-branch]', branch || 'Detached HEAD');
  setText('[data-overview-base]', shortBase);
  setText('[data-overview-built]', builtAt ? new Date(builtAt).toLocaleString() : '—');
  setText('[data-push-branch]', branch || 'HEAD');
  setText('[data-history-branch]', branch || 'Detached HEAD');
  setText('[data-history-base]', shortBase);
  setText('[data-export-branch]', branch || 'Detached HEAD');
  setText('[data-export-base]', shortBase);
  setText('[data-push-command]', `git push origin ${branch || 'HEAD'}`);
  const githubTarget = repository.githubTarget;
  const pushAction = document.querySelector('[data-github-push-action]');
  const hasGitHubTarget = Boolean(githubTarget?.owner && githubTarget?.repo);
  if (pushAction instanceof HTMLButtonElement) {
    pushAction.hidden = !hasGitHubTarget;
    pushAction.disabled = !branch;
    pushAction.title = branch ? '' : 'The repository has no current branch to push.';
  }
  document.querySelectorAll('[data-github-owner]').forEach((element) => { element.textContent = hasGitHubTarget ? String(githubTarget.owner) : '—'; });
  document.querySelectorAll('[data-github-repo]').forEach((element) => { element.textContent = hasGitHubTarget ? String(githubTarget.repo) : '—'; });
  document.querySelectorAll('[data-github-branch]').forEach((element) => { element.textContent = branch || 'No current branch'; });
  setText('[data-push-command]', `git push origin ${branch || 'HEAD'}`);
  const staleWarning = document.querySelector('[data-stale-warning]');
  if (staleWarning) staleWarning.hidden = !repository.staleBase;
  updateSidebarStatus();
}

function renderCommits() {
  const list = document.querySelector('[data-history-list]');
  if (!list) return;
  list.replaceChildren();
  setText('[data-history-count]', `${commits.length} commit${commits.length === 1 ? '' : 's'} in history`);
  setText('[data-commit-count]', String(commits.length));
  const hasChanges = statuses.some((item) => statusFor(item.path) !== 'Tracked');
  setText('[data-worktree-status]', hasChanges ? 'WORKTREE CHANGES' : 'CLEAN WORKTREE');
  commits.forEach((commit, index) => {
    const entry = document.createElement('div');
    entry.className = 'history-entry';
    const node = document.createElement('span');
    node.className = `history-node${index === 0 ? ' current-node' : ''}`;
    const body = document.createElement('div');
    body.className = 'history-entry-body';
    const message = document.createElement('strong');
    message.textContent = commit.message || '(no commit message)';
    const description = document.createElement('p');
    description.textContent = index === 0 ? 'Current HEAD' : 'Local repository commit';
    const meta = document.createElement('div');
    const hash = document.createElement('code');
    hash.textContent = commit.oid.slice(0, 10);
    const author = document.createElement('span');
    author.textContent = commit.author || commit.email || 'Unknown author';
    const date = document.createElement('span');
    date.textContent = new Date(commit.timestamp * 1000).toLocaleString();
    for (const [position, item] of [hash, author, date].entries()) {
      if (position) {
        const separator = document.createElement('span');
        separator.textContent = '·';
        meta.append(separator);
      }
      meta.append(item);
    }
    body.append(message, description, meta);
    entry.append(node, body);
    if (index < commits.length - 1) {
      const line = document.createElement('span');
      line.className = 'history-branch-line';
      entry.append(line);
    }
    list.append(entry);
  });
}

function renderDiffPreview(preview, counts, result) {
  preview.replaceChildren();
  preview.classList.toggle('diff-message', result.kind !== 'text');
  if (result.kind !== 'text') {
    preview.textContent = result.message || 'Diff preview unavailable.';
    counts.textContent = '';
    return;
  }
  counts.textContent = `+${result.added} −${result.removed}`;
  if (!result.rows.length) {
    preview.textContent = 'No text differences in the current worktree.';
    preview.classList.add('diff-message');
    return;
  }
  for (const row of result.rows) {
    const line = document.createElement('span');
    line.className = `diff-line diff-${row.type}`;
    if (row.type === 'gap') {
      line.textContent = '…';
    } else {
      const marker = row.type === 'addition' ? '+' : row.type === 'removal' ? '-' : ' ';
      const lineNumber = row.type === 'addition' ? row.newLine : row.oldLine;
      line.textContent = `${marker} ${String(lineNumber ?? '').padStart(4, ' ')} ${row.text}`;
    }
    preview.append(line);
  }
}

function renderChanges() {
  const list = document.querySelector('[data-change-list]');
  if (!list) return;
  list.replaceChildren();
  const changed = statuses
    .filter((item) => statusFor(item.path) !== 'Tracked')
    .sort((a, b) => a.path.localeCompare(b.path));
  setText('[data-change-count]', `${changed.length} changed file${changed.length === 1 ? '' : 's'}`);
  if (!changed.length) {
    const empty = document.createElement('p');
    empty.className = 'change-empty';
    empty.textContent = 'No uncommitted changes. Save edits in the editor to review them here.';
    list.append(empty);
    return;
  }
  for (const item of changed) {
    const details = document.createElement('details');
    details.className = 'change-file';
    const summary = document.createElement('summary');
    const path = document.createElement('code');
    path.className = 'change-file-path';
    path.textContent = item.path;
    const badge = document.createElement('span');
    badge.className = 'change-status';
    badge.textContent = statusFor(item.path);
    const counts = document.createElement('span');
    counts.className = 'diff-counts';
    summary.append(path, badge, counts);
    const preview = document.createElement('pre');
    preview.className = 'change-diff';
    preview.textContent = 'Expand to load diff.';
    details.append(summary, preview);
    details.addEventListener('toggle', async () => {
      if (!details.open || details.dataset.diffLoaded === 'true' || details.dataset.diffLoading === 'true') return;
      details.dataset.diffLoading = 'true';
      preview.classList.remove('diff-message');
      preview.textContent = 'Loading diff…';
      try {
        const result = await callWorker('diff', { path: item.path });
        renderDiffPreview(preview, counts, result);
        details.dataset.diffLoaded = 'true';
      } catch (error) {
        preview.classList.add('diff-message');
        preview.textContent = `Diff unavailable: ${error instanceof Error ? error.message : String(error)}`;
      } finally {
        delete details.dataset.diffLoading;
      }
    });
    list.append(details);
  }
}

async function refreshRepository(initial = false) {
  if (initial) {
    const result = await callWorker('init', { baseUrl: BASE_URL });
    repository = result.metadata;
    files = result.files;
    statuses = result.status;
    commits = result.log;
  } else {
    const [nextFiles, nextStatus, nextMeta, nextLog] = await Promise.all([
      callWorker('list'), callWorker('status'), callWorker('metadata'), callWorker('log'),
    ]);
    files = nextFiles;
    statuses = nextStatus;
    repository = nextMeta;
    commits = nextLog;
  }
  renderMetadata();
  renderFileList();
  renderRecentFiles();
  renderChanges();
  renderCommits();
  updateEditorState();
  setText('[data-repository-state]', `${files.length} files ready in this browser`);
}

function categoryFolder() {
  return category === 'menus' ? 'src/data/menus/' : category === 'blog' ? 'src/content/blog/' : 'src/content/pages/';
}

function readRememberedCommitAuthor() {
  const prefix = `${COMMIT_AUTHOR_COOKIE}=`;
  const cookie = document.cookie.split(';').map((part) => part.trim()).find((part) => part.startsWith(prefix));
  if (!cookie) return null;
  try {
    const author = JSON.parse(decodeURIComponent(cookie.slice(prefix.length)));
    if (typeof author?.name !== 'string' || typeof author?.email !== 'string') return null;
    return author;
  } catch {
    return null;
  }
}

function rememberCommitAuthor(name, email) {
  const value = encodeURIComponent(JSON.stringify({ name: name.trim(), email: email.trim() }));
  const secure = window.location.protocol === 'https:' ? '; Secure' : '';
  try {
    document.cookie = `${COMMIT_AUTHOR_COOKIE}=${value}; Path=${BASE_URL}; Max-Age=${COMMIT_AUTHOR_COOKIE_MAX_AGE}; SameSite=Lax${secure}`;
  } catch {
    return;
  }
}

function prefillCommitAuthor() {
  const author = readRememberedCommitAuthor();
  const form = document.querySelector('[data-commit-form]');
  if (!author || !(form instanceof HTMLFormElement)) return;
  const nameInput = form.elements.namedItem('authorName');
  const emailInput = form.elements.namedItem('authorEmail');
  if (nameInput instanceof HTMLInputElement && !nameInput.value) nameInput.value = author.name;
  if (emailInput instanceof HTMLInputElement && !emailInput.value) emailInput.value = author.email;
}

function openDialog(name) {
  const dialog = document.querySelector(`[data-dialog="${name}"]`);
  if (name === 'commit') prefillCommitAuthor();
  if (dialog instanceof HTMLDialogElement && !dialog.open) dialog.showModal();
}

function closeDialog(name) {
  if ((name === 'github-push' && githubPushInProgress) || (name === 'published-reset' && resetInProgress)) return;
  const dialog = document.querySelector(`[data-dialog="${name}"]`);
  if (dialog instanceof HTMLDialogElement && dialog.open) dialog.close();
}

function openGitHubPushDialog() {
  if (!repository?.githubTarget?.owner || !repository.githubTarget.repo || !repository.branch) return;
  const tokenInput = document.querySelector('#github-push-token');
  const status = document.querySelector('[data-github-push-status]');
  if (tokenInput instanceof HTMLInputElement) tokenInput.value = '';
  if (status) {
    status.textContent = '';
    status.hidden = true;
  }
  openDialog('github-push');
  tokenInput?.focus();
}

async function prepareGitHubPush() {
  try {
    if (await mayLeaveCurrentFile()) openGitHubPushDialog();
  } catch (error) {
    showToast(`Could not prepare GitHub push: ${error.message}`);
  }
}

function openPublishedResetDialog() {
  const confirmationInput = document.querySelector('#published-reset-confirmation');
  const status = document.querySelector('[data-published-reset-status]');
  const validation = document.querySelector('[data-published-reset-validation]');
  if (confirmationInput instanceof HTMLInputElement) confirmationInput.checked = false;
  if (status) {
    status.textContent = '';
    status.hidden = true;
  }
  if (validation) {
    validation.textContent = '';
    validation.hidden = true;
  }
  setText('[data-reset-branch]', repository?.branch || '—');
  setText('[data-reset-head]', repository?.headSha?.slice(0, 12) || '—');
  openDialog('published-reset');
  confirmationInput?.focus();
}

document.querySelector('#published-reset-confirmation')?.addEventListener('change', () => {
  const validation = document.querySelector('[data-published-reset-validation]');
  if (validation) {
    validation.textContent = '';
    validation.hidden = true;
  }
});

function handleAction(action) {
  switch (action) {
    case 'save': void saveSelected().catch((error) => showToast(`Save failed: ${error.message}`)); break;
    case 'commit': openDialog('commit'); break;
    case 'download': openDialog('download'); break;
    case 'export': void exportRepository(); break;
    case 'new-file':
      if (document.querySelector('[data-new-file-form]')) {
        const input = document.querySelector('[name="path"]');
        if (input && !input.value && currentView !== 'files') input.value = `${categoryFolder()}new-file.${category === 'menus' ? 'yaml' : 'md'}`;
        openDialog('new-file');
      }
      break;
    case 'github-push': void prepareGitHubPush(); break;
    case 'reset-published': openPublishedResetDialog(); break;
    case 'delete': void deleteSelected(); break;
    case 'upload': document.querySelector('[data-upload-input]')?.click(); break;
    case 'download-file': void downloadSelectedFile(); break;
    case 'flow-help': void selectView('commits'); break;
    case 'toggle-markdown-mode': toggleMarkdownMode(); break;
    default: break;
  }
}

async function exportRepository() {
  try {
    syncMarkdownEditorToSource();
    if (editor && selectedPath && isTextFile && editor.value !== editorBaselineText) {
      if (!window.confirm('Save unsaved editor changes before exporting?')) return;
      await callWorker('write', { path: selectedPath, contents: editor.value });
      editorBaselineText = editor.value;
      markdownVisualEdited = false;
      await refreshRepository();
    }
    const data = await callWorker('export');
    const blob = new Blob([data], { type: 'application/zip' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = 'repository.zip';
    anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    closeDialog('download');
    showToast('Repository ZIP downloaded with the current worktree and Git history.');
  } catch (error) {
    showToast(`Export failed: ${error.message}`);
  }
}

async function downloadSelectedFile() {
  if (!selectedPath) return;
  try {
    const result = await callWorker('read', { path: selectedPath });
    const content = result.isText ? result.text : result.bytes;
    const blob = new Blob([content], { type: result.isText ? 'text/plain;charset=utf-8' : imageMime(selectedPath) });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = selectedPath.split('/').at(-1);
    anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch (error) {
    showToast(`Download failed: ${error.message}`);
  }
}

async function renameSelected() {
  if (!selectedPath || !(await mayLeaveCurrentFile())) return;
  const from = selectedPath;
  const to = window.prompt('New repository-relative path', from);
  if (to === null || !to.trim() || to.trim() === from) return;
  if (!window.confirm(`Rename ${from} to ${to.trim()}?`)) return;
  try {
    await callWorker('rename', { from, to: to.trim() });
    selectedPath = '';
    await refreshRepository();
    await openFile(to.trim());
    showToast('File renamed in the local worktree.');
  } catch (error) {
    showToast(`Rename failed: ${error.message}`);
  }
}

async function deleteSelected() {
  if (!selectedPath || !(await mayLeaveCurrentFile())) return;
  const path = selectedPath;
  if (!window.confirm(`Delete ${path} from the local worktree? This change will be included in the next commit.`)) return;
  try {
    await callWorker('remove', { path });
    await clearSelectedFile();
    await refreshRepository();
    showToast('File deleted from the local worktree.');
  } catch (error) {
    showToast(`Delete failed: ${error.message}`);
  }
}

async function selectView(name) {
  if (['menus', 'blog', 'content', 'files'].includes(name)) {
    if (!(await mayLeaveCurrentFile())) return;
    if (name === 'files') {
      document.querySelector('.category-tabs').hidden = true;
      setText('[data-editor-heading]', 'Files');
      setText('[data-list-heading]', 'Files');
      setText('[data-editor-description]', 'Browse and edit any text or asset file in the local repository.');
      showScreen('editor', 'files');
    } else {
      category = name;
      document.querySelector('.category-tabs').hidden = false;
      document.querySelectorAll('[data-category]').forEach((tab) => {
        const active = tab.dataset.category === category;
        tab.classList.toggle('is-active', active);
        tab.setAttribute('aria-selected', String(active));
      });
      setText('[data-editor-heading]', categoryNames[name]);
      setText('[data-list-heading]', categoryNames[name]);
      setText('[data-editor-description]', name === 'menus' ? 'Edit menu files in the local working tree.' : name === 'blog' ? 'Edit blog posts from the repository.' : 'Edit content pages from the repository.');
      showScreen('editor', name);
    }
    fileFilter = '';
    const search = document.querySelector('[data-file-search]');
    if (search) search.value = '';
    renderFileList();
    const first = files.find(({ path }) => name === 'files' || kindFor(path) === category);
    if (first) await openFile(first.path);
    else await clearSelectedFile();
    return;
  }
  if (!(await mayLeaveCurrentFile())) return;
  if (name === 'commits') {
    showScreen('commits', 'commits');
    return;
  }
  showScreen('overview', 'overview');
}

document.addEventListener('click', (event) => {
  const target = event.target instanceof Element ? event.target : null;
  if (!target) return;
  const view = target.closest('[data-view]');
  if (view instanceof HTMLElement) {
    event.preventDefault();
    void selectView(view.dataset.view || 'overview');
    return;
  }
  const categoryTab = target.closest('[data-category]');
  if (categoryTab instanceof HTMLElement) {
    void selectView(categoryTab.dataset.category || 'menus');
    return;
  }
  const file = target.closest('[data-file]');
  if (file instanceof HTMLElement) {
    void openFile(file.dataset.file || '');
    return;
  }
  const recent = target.closest('[data-open-file]');
  if (recent instanceof HTMLElement) {
    void selectView('files').then(() => openFile(recent.dataset.openFile || ''));
    return;
  }
  const close = target.closest('[data-close]');
  if (close) { closeDialog(close.closest('dialog')?.dataset.dialog || ''); return; }
  const action = target.closest('[data-action]');
  if (action instanceof HTMLElement) handleAction(action.dataset.action || '');
});

document.querySelector('[data-file-search]')?.addEventListener('input', (event) => {
  const input = event.currentTarget;
  if (!(input instanceof HTMLInputElement)) return;
  fileFilter = input.value.trim();
  renderFileList();
});

editor?.addEventListener('input', () => {
  updateLineNumbers();
  updateEditorState();
});
editor?.addEventListener('scroll', () => {
  if (editor && lineGutter) lineGutter.scrollTop = editor.scrollTop;
});

document.querySelector('[data-github-push-form]')?.addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  if (!(form instanceof HTMLFormElement) || githubPushInProgress || !form.reportValidity()) return;
  const tokenInput = form.querySelector('input[name="token"]');
  const status = form.querySelector('[data-github-push-status]');
  const submitButton = form.querySelector('[data-github-push-submit]');
  if (!(tokenInput instanceof HTMLInputElement)) return;
  let token = tokenInput.value;
  if (!token) return;
  tokenInput.value = '';
  githubPushInProgress = true;
  if (submitButton instanceof HTMLButtonElement) submitButton.disabled = true;
  if (status) {
    status.textContent = `Pushing to ${repository?.githubTarget?.owner}/${repository?.githubTarget?.repo}…`;
    status.hidden = false;
  }
  try {
    const result = await callWorker('github-push', { token });
    rememberPushedUpstream(result);
    const branch = typeof result?.branch === 'string' ? result.branch : repository?.branch || 'current branch';
    const pushedCount = Number.isSafeInteger(result?.pushedCount) && result.pushedCount >= 0 ? result.pushedCount : 0;
    const message = result?.upToDate
      ? `Branch ${branch} is already up to date (${pushedCount} commits pushed).`
      : `Pushed ${pushedCount} commit${pushedCount === 1 ? '' : 's'} to ${branch}.`;
    githubPushInProgress = false;
    closeDialog('github-push');
    showToast(message);
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'Unexpected error.';
    const safeDetail = token ? detail.split(token).join('[redacted]') : detail;
    if (status) {
      status.textContent = `GitHub push failed: ${safeDetail} Check your network connection, confirm the token is valid and grants Contents: write access to this repository, and resolve any remote branch changes before retrying.`;
      status.hidden = false;
    }
  } finally {
    token = '';
    tokenInput.value = '';
    githubPushInProgress = false;
    if (submitButton instanceof HTMLButtonElement) submitButton.disabled = false;
  }
});

document.querySelector('[data-published-reset-form]')?.addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  if (!(form instanceof HTMLFormElement) || resetInProgress) return;
  const confirmationInput = form.querySelector('input[name="confirmation"]');
  const validation = form.querySelector('[data-published-reset-validation]');
  const status = form.querySelector('[data-published-reset-status]');
  const submitButton = form.querySelector('[data-published-reset-submit]');
  if (!(confirmationInput instanceof HTMLInputElement)) return;
  if (!confirmationInput.checked) {
    if (validation) {
      validation.textContent = 'Check the box to confirm replacing this browser workspace.';
      validation.hidden = false;
    }
    confirmationInput.focus();
    return;
  }
  if (validation) {
    validation.textContent = '';
    validation.hidden = true;
  }
  if (!form.reportValidity()) return;
  resetInProgress = true;
  if (submitButton instanceof HTMLButtonElement) submitButton.disabled = true;
  if (status) {
    status.textContent = 'Fetching and validating the current server snapshot…';
    status.hidden = false;
  }
  let resetComplete = false;
  try {
    const result = await callWorker('reset-published', { confirmation: confirmationInput.checked });
    resetComplete = true;
    selectedPath = '';
    await clearSelectedFile();
    await refreshRepository();
    showScreen('overview', 'overview');
    const message = result.cleanupWarning
      ? 'Published snapshot restored, but old browser data cleanup was incomplete. Retry the reset to finish cleanup.'
      : `Browser workspace reset to published snapshot ${result.baseSha.slice(0, 10)}.`;
    resetInProgress = false;
    closeDialog('published-reset');
    form.reset();
    showToast(message);
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'Unexpected error.';
    if (status) {
      status.textContent = resetComplete
        ? `The reset completed, but the interface could not reload the repository: ${detail} Reload the page.`
        : `Reset failed: ${detail}`;
      status.hidden = false;
    }
  } finally {
    resetInProgress = false;
    if (submitButton instanceof HTMLButtonElement) submitButton.disabled = false;
  }
});

document.querySelector('[data-commit-form]')?.addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  if (!(form instanceof HTMLFormElement)) return;
  const validation = form.querySelector('[data-commit-validation]');
  const messageInput = form.elements.namedItem('message');
  const authorNameInput = form.elements.namedItem('authorName');
  const authorEmailInput = form.elements.namedItem('authorEmail');
  let invalidField = null;
  let validationMessage = '';
  if (messageInput instanceof HTMLInputElement && !messageInput.value.trim()) {
    invalidField = messageInput;
    validationMessage = 'Enter a commit message.';
  } else if (authorNameInput instanceof HTMLInputElement && !authorNameInput.value.trim()) {
    invalidField = authorNameInput;
    validationMessage = 'Enter an author name.';
  } else if (authorEmailInput instanceof HTMLInputElement && !authorEmailInput.value.trim()) {
    invalidField = authorEmailInput;
    validationMessage = 'Enter an author email address.';
  } else if (authorEmailInput instanceof HTMLInputElement && !authorEmailInput.validity.valid) {
    invalidField = authorEmailInput;
    validationMessage = 'Enter a valid email address, such as name@example.com.';
  }
  if (validationMessage) {
    if (validation) {
      validation.textContent = validationMessage;
      validation.hidden = false;
    }
    invalidField?.focus();
    return;
  }
  if (validation) {
    validation.textContent = '';
    validation.hidden = true;
  }
  if (!form.reportValidity()) return;
  const data = new FormData(form);
  const authorName = String(data.get('authorName') || '');
  const authorEmail = String(data.get('authorEmail') || '');
  try {
    syncMarkdownEditorToSource();
    if (editor && isTextFile && editor.value !== editorBaselineText) {
      await callWorker('write', { path: selectedPath, contents: editor.value });
      editorBaselineText = editor.value;
      markdownVisualEdited = false;
    }
    const commit = await callWorker('commit', {
      message: String(data.get('message') || ''),
      authorName,
      authorEmail,
    });
    rememberCommitAuthor(authorName, authorEmail);
    closeDialog('commit');
    form.reset();
    await refreshRepository();
    showToast(`Created commit ${commit.oid.slice(0, 10)}.`);
  } catch (error) {
    showToast(`Commit failed: ${error.message}`);
  }
});

document.querySelector('[data-commit-form]')?.addEventListener('input', () => {
  const validation = document.querySelector('[data-commit-validation]');
  if (validation) {
    validation.textContent = '';
    validation.hidden = true;
  }
});

document.querySelector('[data-new-file-form]')?.addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  if (!(form instanceof HTMLFormElement) || !form.reportValidity()) return;
  if (!(await mayLeaveCurrentFile())) return;
  const data = new FormData(form);
  const path = String(data.get('path') || '').trim();
  if (files.some((file) => file.path === path)) {
    showToast('That repository path already exists. Choose a new path.');
    return;
  }
  try {
    await callWorker('write', { path, contents: String(data.get('content') || '') });
    closeDialog('new-file');
    form.reset();
    selectedPath = '';
    await refreshRepository();
    showScreen('editor', currentView);
    await openFile(path);
    showToast('New text file created in the local worktree.');
  } catch (error) {
    showToast(`Could not create file: ${error.message}`);
  }
});

document.querySelector('[data-upload-input]')?.addEventListener('change', async (event) => {
  const input = event.currentTarget;
  if (!(input instanceof HTMLInputElement) || !input.files?.length) return;
  const file = input.files[0];
  if (!(await mayLeaveCurrentFile())) { input.value = ''; return; }
  const requestedPath = window.prompt('Repository path for this asset. Keep the current path to replace it, or enter a new path.', selectedPath || file.name);
  if (!requestedPath || !requestedPath.trim()) { input.value = ''; return; }
  const path = requestedPath.trim();
  if (files.some((entry) => entry.path === path) && !window.confirm(`Replace ${path} with ${file.name}?`)) { input.value = ''; return; }
  try {
    const buffer = await file.arrayBuffer();
    await callWorker('write', { path, contents: buffer }, [buffer]);
    selectedPath = '';
    await refreshRepository();
    await openFile(path);
    showToast('Asset uploaded to the local worktree.');
  } catch (error) {
    showToast(`Upload failed: ${error.message}`);
  } finally {
    input.value = '';
  }
});

document.querySelectorAll('[data-dialog]').forEach((dialog) => {
  const isBusy = () => (dialog.dataset.dialog === 'github-push' && githubPushInProgress) || (dialog.dataset.dialog === 'published-reset' && resetInProgress);
  dialog.addEventListener('click', (event) => { if (event.target === dialog && !isBusy()) dialog.close(); });
  if (dialog.dataset.dialog === 'github-push' || dialog.dataset.dialog === 'published-reset') {
    dialog.addEventListener('cancel', (event) => { if (isBusy()) event.preventDefault(); });
    dialog.addEventListener('close', () => {
      const tokenInput = dialog.querySelector('input[name="token"]');
      const confirmationInput = dialog.querySelector('input[name="confirmation"]');
      const status = dialog.querySelector('[role="alert"][aria-live="assertive"]');
      if (tokenInput instanceof HTMLInputElement) tokenInput.value = '';
      if (confirmationInput instanceof HTMLInputElement) confirmationInput.value = '';
      if (status) {
        status.textContent = '';
        status.hidden = true;
      }
    });
  }
});

async function initializeEditor() {
  try {
    await refreshRepository(true);
    showScreen('overview', 'overview');
  } catch (error) {
    setText('[data-repository-state]', 'Repository initialization failed');
    setText('[data-sidebar-state]', 'Initialization failed');
    showToast(`Could not open repository: ${error.message}`);
  }
}

void initializeEditor();
