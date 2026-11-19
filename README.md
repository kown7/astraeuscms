# AstraeusCMS

A local-first CMS for Astro. Edit the repository in `/admin/`; use its Git page to review working-tree diffs and history, and create local commits. Markdown (`.md` and `.markdown`) files open in an in-app CKEditor 5 WYSIWYG editor; use **Source** to edit the full file, including Astro frontmatter. Visual edits serialize to GitHub Flavored Markdown and remain in the browser worktree until saved. MDX and other text files stay in the plain source editor. CKEditor 5’s GPL build is used with this repository’s GPLv3 license; unsupported Markdown constructs may be normalized in visual mode, so use Source for syntax that needs exact preservation. Commit author name and email are remembered in a site-scoped cookie; resetting the workspace requires checking a confirmation box. Explicitly push to GitHub with a fine-grained PAT, reset the browser workspace to the repository ZIP from the current deployment, or download the full repository and push from your console. PATs are used only for pushes and are not saved; page code can read them while entered, so use a repository-scoped token.

The sidebar status dot is red for uncommitted changes, orange when local `HEAD` differs from the last-known upstream commit, and green when aligned. It uses the deployed snapshot or the most recent explicit push result; GitHub is not polled in the background.

At development start, `npm run dev` creates a `.git`-only snapshot from the current `HEAD` (allowing a dirty worktree). `npm run build` requires a clean working tree and packages the current Git metadata into `public/admin/base-git.zip`, alongside `public/admin/snapshot.json`; the browser checks out that commit to materialize the files.

## Run locally

Requires Node.js `>=22.23.4` and npm `>=9.6.5`.

```sh
npm install
npm run dev
```

Open `http://localhost:4321/admin/`.

`npm run build` writes the static site to the Git-ignored `dist/` folder. GitHub Actions builds with `ASTRO_BASE=/astraeuscms` and deploys `dist/` to Pages on pushes to `main`; set the repository’s Pages source to **GitHub Actions**. The build requires a normal, non-bare Git working copy with full history and a named branch.

After editing, use **Push to GitHub** with a fine-grained PAT that has repository `Contents: write`. **Reset to snapshot** replaces this browser’s local edits and commits with the ZIP in the current deployment; export the repository first if you need to keep that work. Reset does not fetch GitHub—the deployment snapshot changes only after a new build and deployment. Alternatively, download the repository ZIP and use `git status`, `git log`, and `git push origin <branch>` from your console.

## Snapshot metadata and optional encryption

`admin/snapshot.json` is public and contains the snapshot version, base commit SHA, branch, build timestamp, archive-encryption mode, and AES-GCM IV when enabled. It contains no repository files, key, or credentials. This metadata remains visible when the ZIP is encrypted.

`ASTRAEUSCMS_SNAPSHOT_KEY_HEX` is optional. When unset or empty, builds publish a plaintext `base-git.zip`; when set, it must be a 32-byte AES key encoded as exactly 64 hexadecimal characters, and the build encrypts the ZIP with AES-256-GCM. The GitHub Actions workflow reads this value from the repository Actions secret of the same name; if that secret is absent, deployment remains plaintext. Local encrypted builds use the same environment variable.

Generate a key once with:

```sh
openssl rand -hex 32
```

The output is exactly 64 hexadecimal characters (32 bytes). Example format only—do not use this as a real key: `0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef`. Save the generated key in a password manager and as the GitHub Actions secret `ASTRAEUSCMS_SNAPSHOT_KEY_HEX`; reuse that same key for later builds so existing encrypted snapshots remain unlockable. For local builds, export the saved value as `ASTRAEUSCMS_SNAPSHOT_KEY_HEX` before running `npm run build` or `npm run dev`.

Users opening or resetting to an encrypted snapshot must enter the key out of band. The browser uses it only to decrypt the ZIP and does not store it. A wrong key leaves the current workspace unchanged. This protects only the published base ZIP: it does not encrypt browser-local repository data or exported ZIPs, and it cannot hide a publicly readable GitHub repository.

The sidebar uses 📄 for `none` and 🔑 for `aes-256-gcm`. A missing key selects plaintext mode.
