# Astro CMS

A local-first CMS for Astro. Edit the repository in `/admin/`; use its Git page to review working-tree diffs and history, and create local commits. Markdown (`.md` and `.markdown`) files open in an in-app CKEditor 5 WYSIWYG editor; use **Source** to edit the full file, including Astro frontmatter. Visual edits serialize to GitHub Flavored Markdown and remain in the browser worktree until saved. MDX and other text files stay in the plain source editor. CKEditor 5’s GPL build is used with this repository’s GPLv3 license; unsupported Markdown constructs may be normalized in visual mode, so use Source for syntax that needs exact preservation. Explicitly push to GitHub with a fine-grained PAT, reset the browser workspace to the repository ZIP from the current deployment, or download the full repository and push from your console. PATs are used only for pushes and are not saved; page code can read them while entered, so use a repository-scoped token.

At development start, `npm run dev` creates a `.git`-only snapshot from the current `HEAD` (allowing a dirty worktree). `npm run build` requires a clean working tree and packages the current Git metadata into `public/admin/base-git.zip`, alongside `public/admin/snapshot.json`; the browser checks out that commit to materialize the files.

## Run locally

Requires Node.js `>=22.23.4` and npm `>=9.6.5`.

```sh
npm install
npm run dev
```

Open `http://localhost:4321/admin/`.

`npm run build` writes the static site to the Git-ignored `dist/` folder. GitHub Actions builds with `ASTRO_BASE=/astrocms` and deploys `dist/` to Pages on pushes to `main`; set the repository’s Pages source to **GitHub Actions**. The build requires a normal, non-bare Git working copy with full history and a named branch.

After editing, use **Push to GitHub** with a fine-grained PAT that has repository `Contents: write`. **Reset to snapshot** replaces this browser’s local edits and commits with the ZIP in the current deployment; export the repository first if you need to keep that work. Reset does not fetch GitHub—the deployment snapshot changes only after a new build and deployment. Alternatively, download the repository ZIP and use `git status`, `git log`, and `git push origin <branch>` from your console.
