const OMITTED_ROOTS = new Set(['.astro', 'dist', 'node_modules', '.wrangler']);
const OMITTED_SEGMENTS = new Set(['.git', '.ssh', '.aws']);
const OMITTED_FILES = new Set([
  '.npmrc',
  '.gitconfig',
  '.git-credentials',
  '.netrc',
  '.envrc',
  'credentials.json',
  'service-account.json',
  'id_rsa',
  'id_ed25519',
  'id_ecdsa',
  'id_dsa',
]);
const SAMPLE_ENV_SUFFIX = /\.(?:example|sample|template)$/i;

function isEnvironmentFile(name) {
  return /^\.env(?:\.|$)/i.test(name);
}

export function isExcludedPreviewPath(relative) {
  const segments = relative.split('/');
  if (segments.some((segment) => OMITTED_SEGMENTS.has(segment.toLowerCase()))) return true;
  if (OMITTED_ROOTS.has(segments[0].toLowerCase())) return true;
  for (let index = 0; index < segments.length - 1; index += 1) {
    if (isEnvironmentFile(segments[index])) return true;
  }
  const basename = segments.at(-1).toLowerCase();
  if (OMITTED_FILES.has(basename)) return true;
  if (isEnvironmentFile(basename) && !SAMPLE_ENV_SUFFIX.test(basename)) return true;
  return /\.(?:pem|p12|pfx|key)$/i.test(basename);
}

export function isSafePreviewSymlink(relative, target) {
  if (!target || target.startsWith('/') || target.includes('\\')) return false;
  const resolved = relative.split('/').slice(0, -1);
  for (const segment of target.split('/')) {
    if (!segment || segment === '.') continue;
    if (segment === '..') {
      if (!resolved.length) return false;
      resolved.pop();
    } else {
      resolved.push(segment);
    }
  }
  return true;
}
