# Git workflow

The site is version-controlled at **https://github.com/ir44747-stack/nipcoupon**
(public, branch `main`). Changes can be committed and pushed on request.

---

## Current state

```
local  ead4d9b
remote ead4d9b     ahead 0 · behind 0
```

Recent history:

| Commit | What |
|---|---|
| `ead4d9b` | `git-sync.sh` helper; GitHub token added to secret audit |
| `d8a88c3` | Untrack `.github/workflows/cj-sync.yml` (token lacks `workflow` scope) |
| `a0c655a` | Remove stray `nipcoupon-vercel-deploy/` duplicate folder |
| `7384482` | Merge the two pre-existing "Add files via upload" commits |
| `6a4aa1f` | Full project: secure API layer, dynamic routes, refreshed catalogue |

The two original drag-and-drop commits (`1716bef`, `aeeb17c`) are preserved in
history — nothing was force-pushed over.

---

## Authentication

Credentials live in **`/home/user/.git-credentials`** (mode `600`), which is
**outside the repository** so it can never be committed:

```
https://ir44747-stack:<token>@github.com
```

`credential.helper store` is set globally, so the remote URL itself is clean
(no token embedded in `.git/config`).

Identity: `ir44747-stack <ir44747-stack@users.noreply.github.com>` — GitHub's
noreply address, so no personal email is exposed in public commit metadata.

> **Rotate the token.** It was pasted into a chat window and is therefore
> compromised. When you do, update `~/.git-credentials` — nothing else changes.

---

## Pushing changes

```bash
./scripts/git-sync.sh "update hero copy and add 3 Nike codes"
./scripts/git-sync.sh --dry-run     # preview, no commit
```

`git-sync.sh` runs three gates before anything leaves the machine:

1. **Refuses** if `.env`, `backups/`, or `cj-feed.json` / `cj-links.json` /
   `sovrn-links.json` are staged
2. **Runs `scripts/purge-secrets.js`** and aborts if a live secret is in tracked files
3. Reports exactly which files are being committed

Verified: attempting to stage `.env` is rejected.

---

## Known limitation — `workflow` scope

The PAT has scope **`repo`** but **not `workflow`**. GitHub blocks creating or
updating `.github/workflows/*` without it, so the push was rejected until that
file was excluded.

`cj-sync.yml` is therefore **locally excluded** via `.git/info/exclude` (a
local-only file, so the committed `.gitignore` stays correct). The file is
still on disk. CJ integration is suspended, so nothing is broken today.

To restore it:

1. Regenerate the PAT at **github.com/settings/tokens** with `repo` **and**
   `workflow` scopes
2. Update `~/.git-credentials`
3. ```bash
   rm -f .git/info/exclude
   git add .github/workflows/cj-sync.yml
   ./scripts/git-sync.sh "restore CJ sync workflow"
   ```

---

## Cleaning up the old folder

The repository contained `nipcoupon-vercel-deploy/`, an extracted copy of the
deploy zip. I verified it was a pure duplicate — **all 43 files identical to the
project root, zero unique content** — and removed it, dropping tracked files
from 91 to 48. It remains reachable in history (`7384482^2`) if you want it back.

---

## Safety record

| Check | Result |
|---|---|
| Token in tracked files | 0 matches |
| `.env` tracked | no |
| `backups/` tracked | 0 files |
| Secrets in published `data/stores.json` | none (Sovrn key, secret, PAT) |
| Files on remote | `index.html`, `sitemap.xml` (86 URLs), `api/*`, `scripts/*` ✓ |

`GITHUB_TOKEN` and `GH_TOKEN` were added to `SECRET_KEYS` in `api/_secrets.js`,
so `npm run secrets:audit` now catches a leaked PAT in data files too.

---

## Deploying to Vercel

Pushing to GitHub does **not** deploy — the site is uploaded by drag & drop.
To make pushes deploy automatically, connect the repo in Vercel
(vercel.com/new → Import `ir44747-stack/nipcoupon`).
