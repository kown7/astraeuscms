import { isExcludedPreviewPath } from './preview-paths.js';
const dialog = document.querySelector('[data-dialog="local-preview"]');
const status = dialog?.querySelector('[data-preview-status]');
const output = dialog?.querySelector('[data-preview-output]');
const frame = dialog?.querySelector('[data-preview-frame]');
const rebuildButton = dialog?.querySelector('[data-preview-rebuild]');
const MAX_OUTPUT_LENGTH = 16_000;
const ANSI_ESCAPE_SEQUENCE = /\u001b\[[0-?]*[ -/]*[@-~]/g;
const PREVIEW_COMMAND_ENV = { NO_COLOR: '1', npm_config_color: 'false' };

let webContainerPromise;
let webContainer;
let activeProcess;
let previewProcess;
let runGeneration = 0;
let busy = false;
let getPreviewFiles;
let installedDependencies = '';

function isCurrent(generation) {
  return generation === runGeneration && Boolean(dialog?.open);
}

function setStatus(message) {
  if (status) status.textContent = message;
}

function appendOutput(chunk) {
  if (!output) return;
  output.hidden = false;
  const cleanChunk = chunk.replace(ANSI_ESCAPE_SEQUENCE, '').replace(/\r/g, '\n');
  output.textContent = `${output.textContent}${cleanChunk}`.slice(-MAX_OUTPUT_LENGTH);
  output.scrollTop = output.scrollHeight;
}

function setBusy(value) {
  busy = value;
  if (rebuildButton) rebuildButton.disabled = value;
}


function makeFileTree(files) {
  const tree = Object.create(null);
  let count = 0;

  for (const [path, contents] of Object.entries(files)) {
    if (!path || path.startsWith('/') || path.includes('\\')) throw new Error(`Invalid repository path: ${path}`);
    const segments = path.split('/');
    if (segments.some((segment) => !segment || segment === '.' || segment === '..')) throw new Error(`Unsafe repository path: ${path}`);
    if (isExcludedPreviewPath(path)) continue;

    let directory = tree;
    for (const segment of segments.slice(0, -1)) {
      let entry = directory[segment];
      if (!entry) {
        entry = { directory: Object.create(null) };
        directory[segment] = entry;
      }
      if (!entry.directory) throw new Error(`Conflicting file and directory path: ${path}`);
      directory = entry.directory;
    }

    const name = segments.at(-1);
    if (directory[name]) throw new Error(`Duplicate repository path: ${path}`);
    if (contents instanceof Uint8Array) {
      directory[name] = { file: { contents } };
    } else if (contents && typeof contents.symlink === 'string') {
      directory[name] = { file: { symlink: contents.symlink } };
    } else {
      throw new Error(`Unsupported file data for ${path}`);
    }
    count += 1;
  }

  return { tree, count };
}

function fileText(contents, path) {
  if (!(contents instanceof Uint8Array)) throw new Error(`Missing or invalid ${path}.`);
  return new TextDecoder().decode(contents);
}

async function getContainer() {
  if (!window.isSecureContext || !window.crossOriginIsolated) {
    throw new Error('Preview requires a secure, cross-origin-isolated production page with COOP/COEP enabled.');
  }
  if (!webContainerPromise) {
    webContainerPromise = import('@webcontainer/api')
      .then(({ WebContainer }) => WebContainer.boot({ workdirName: 'astro-preview', forwardPreviewErrors: 'exceptions-only' }))
      .then((instance) => {
        webContainer = instance;
        return instance;
      })
      .catch((error) => {
        webContainerPromise = undefined;
        throw error;
      });
  }
  return webContainerPromise;
}

async function clearWorkspace(container) {
  for (const name of await container.fs.readdir('.')) {
    if (name === 'node_modules') continue;
    await container.fs.rm(name, { recursive: true });
  }
}

async function runCommand(container, command, args, generation, env) {
  const process = await container.spawn(command, args, { env: { ...PREVIEW_COMMAND_ENV, ...env } });
  if (!isCurrent(generation)) {
    process.kill();
    throw new Error('Preview stopped.');
  }
  activeProcess = process;
  const reader = process.output.getReader();
  let outputComplete = false;
  let outputError;
  const outputTask = (async () => {
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (isCurrent(generation)) appendOutput(value);
      }
    } catch (error) {
      if (isCurrent(generation)) outputError = error;
    } finally {
      outputComplete = true;
      reader.releaseLock();
    }
  })();
  const exitCode = await process.exit;
  if (activeProcess === process) activeProcess = undefined;
  if (!outputComplete) {
    await Promise.race([outputTask, new Promise((resolve) => window.setTimeout(resolve, 200))]);
    if (!outputComplete) await reader.cancel().catch(() => {});
  }
  await outputTask;
  if (outputError && isCurrent(generation)) throw outputError;
  if (!isCurrent(generation)) throw new Error('Preview stopped.');
  if (exitCode !== 0) throw new Error(`${command} exited with code ${exitCode}.`);
}

async function waitForPreviewServer(container, generation) {
  let unsubscribe = () => {};
  const ready = new Promise((resolve) => {
    unsubscribe = container.on('server-ready', (port, url) => resolve({ port, url }));
  });
  const process = await container.spawn('npm', ['run', 'preview', '--', '--host', '0.0.0.0'], { env: PREVIEW_COMMAND_ENV });
  if (!isCurrent(generation)) {
    process.kill();
    unsubscribe();
    throw new Error('Preview stopped.');
  }
  previewProcess = process;
  const outputTask = (async () => {
    const reader = process.output.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (isCurrent(generation)) appendOutput(value);
      }
    } catch (error) {
      if (isCurrent(generation)) throw error;
    } finally {
      reader.releaseLock();
    }
  })();
  void process.exit.then(() => {
    if (previewProcess === process) previewProcess = undefined;
    if (isCurrent(generation)) setStatus('The preview server stopped. Rebuild to start it again.');
  });

  let timeoutId;
  try {
    const server = await Promise.race([
      ready,
      process.exit.then((code) => { throw new Error(`Astro preview exited before starting (code ${code}).`); }),
      new Promise((_, reject) => {
        timeoutId = window.setTimeout(() => reject(new Error('Astro preview did not start within 90 seconds.')), 90_000);
      }),
    ]);
    if (!isCurrent(generation)) throw new Error('Preview stopped.');
    frame.src = server.url;
    frame.hidden = false;
    setStatus('Preview ready. Your changes remain in this browser until you push.');
  } catch (error) {
    process.kill();
    if (previewProcess === process) previewProcess = undefined;
    throw error;
  } finally {
    window.clearTimeout(timeoutId);
    unsubscribe();
    void outputTask.catch(() => {});
  }
}

async function buildPreview() {
  if (busy || !dialog || !getPreviewFiles) return;
  const generation = ++runGeneration;
  setBusy(true);
  if (previewProcess) {
    previewProcess.kill();
    previewProcess = undefined;
  }
  if (frame) {
    frame.hidden = true;
    frame.removeAttribute('src');
  }
  if (output) {
    output.textContent = '';
    output.hidden = true;
  }

  try {
    setStatus('Reading the current browser worktree…');
    const files = await getPreviewFiles();
    if (!isCurrent(generation)) return;
    const manifest = JSON.parse(fileText(files['package.json'], 'package.json'));
    if (!manifest.scripts?.build) throw new Error('The repository has no package.json build script.');
    const { tree, count } = makeFileTree(files);
    if (!count) throw new Error('No project files are available to preview.');

    setStatus('Starting the browser Node.js runtime…');
    const container = await getContainer();
    if (!isCurrent(generation)) return;
    await clearWorkspace(container);
    await container.mount(tree);

    const lockfile = files['package-lock.json'];
    const dependencyKey = `${fileText(files['package.json'], 'package.json')}\0${lockfile instanceof Uint8Array ? fileText(lockfile, 'package-lock.json') : ''}`;
    if (installedDependencies !== dependencyKey) {
      setStatus(lockfile instanceof Uint8Array ? 'Installing locked npm dependencies…' : 'Installing npm dependencies…');
      await runCommand(container, 'npm', [lockfile instanceof Uint8Array ? 'ci' : 'install', '--no-progress', '--color=false'], generation);
      installedDependencies = dependencyKey;
    }

    setStatus('Building the Astro site…');
    await runCommand(container, 'npm', ['run', 'build'], generation, { ASTRAEUSCMS_PREVIEW_BUILD: '1' });
    if (!isCurrent(generation)) return;
    setStatus('Starting the local Astro preview…');
    await waitForPreviewServer(container, generation);
  } catch (error) {
    if (isCurrent(generation)) {
      setStatus(`Preview failed: ${error instanceof Error ? error.message : String(error)}`);
      if (frame) frame.hidden = true;
    }
  } finally {
    if (generation === runGeneration) setBusy(false);
  }
}

function stopPreview() {
  runGeneration += 1;
  activeProcess?.kill();
  activeProcess = undefined;
  previewProcess?.kill();
  previewProcess = undefined;
  if (frame) {
    frame.removeAttribute('src');
    frame.hidden = true;
  }
  setBusy(false);
}

rebuildButton?.addEventListener('click', () => { void buildPreview(); });
dialog?.addEventListener('close', stopPreview);

export async function startLocalPreview(loadFiles) {
  if (!dialog || typeof loadFiles !== 'function') throw new Error('The local preview dialog is unavailable.');
  getPreviewFiles = loadFiles;
  if (!dialog.open) dialog.showModal();
  await buildPreview();
}
