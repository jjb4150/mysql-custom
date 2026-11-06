# Release process

How a new version gets built and published. Maintainer-facing.

---

## TL;DR

```bash
# 1. bump the version in package.json
# 2. commit and push
git add package.json && git commit -m "chore: release v0.1.1" && git push

# 3. tag and push the tag — this triggers the release workflow
git tag -a v0.1.1 -m "MySQL Custom 0.1.1"
git push origin v0.1.1
```

GitHub Actions then type-checks, builds, packages the `.vsix`, attaches it to a
GitHub Release, and (if configured) publishes to extension marketplaces.

---

## What the workflow does

`.github/workflows/release.yml`, triggered by pushing a `v*` tag.

| Step | Purpose |
|---|---|
| `tsc --noEmit` | Type gate. Build fails here on type errors. |
| `vsce package` | Builds the bundle (via `vscode:prepublish`) and packages the `.vsix` |
| `upload-artifact` | Keeps the `.vsix` as a run artifact for 90 days |
| `vsce publish` | Publishes to the VS Code Marketplace |
| `ovsx publish` | Publishes to Open VSX (disabled by default) |
| `action-gh-release` | Creates the GitHub Release with the `.vsix` attached |

The webpack build is **not** a separate step. `package.json` declares
`"vscode:prepublish": "webpack --mode=production"`, and `vsce package` invokes it
automatically. Running webpack separately compiles everything twice.

---

## Marketplace publishing

The extension currently publishes to **GitHub Releases only**. Marketplaces are
optional.

### VS Code Marketplace — Trusted Publishing (no long-lived secret)

1. Sign in at <https://marketplace.visualstudio.com/manage>
2. If you have no publisher yet: **Create publisher**. The ID is permanent.
3. On the publisher page: **Trusted Publishing** → **Create**
   - Repository owner: `jjb4150`
   - Repository: `mysql-custom`
   - Workflow: `release.yml`
   - Environment: leave empty
4. Keep `VS_MARKETPLACE_TRUSTED_PUBLISHING: "true"` in the workflow env block.

Marketplace credentials obtained this way expire in 15 minutes, so there is no
secret to store or rotate.

> If the repository is **private**, the trust policy must exchange a token
> successfully within 48 hours of creation or it expires.

### VS Code Marketplace — personal access token

Needs an Azure DevOps organisation, which since 2026 requires an active Azure
subscription. Set `VS_MARKETPLACE_TRUSTED_PUBLISHING: "false"` and add a
`VSCE_PAT` repository secret.

The PAT needs **Marketplace → Manage** scope. When creating it, select a
specific Azure DevOps organisation rather than "All accessible organizations" —
global PATs are being retired.

### Open VSX

1. Register an Eclipse account at <https://accounts.eclipse.org/user/register>.
   The **GitHub Username** field must match the account you sign in with.
2. Sign in at <https://open-vsx.org> with GitHub, then **Settings → Log in with
   Eclipse**, then accept the Publisher Agreement.
3. **Settings → Access Tokens** → generate. It is shown once.
4. `npx ovsx create-namespace junbiaojin -p <token>` — the namespace must equal
   the `publisher` field in `package.json`.
5. Add an `OVSX_PAT` repository secret and set `PUBLISH_TO_OPENVSX: "true"`.

---

## Packaging notes

Things that will bite you if changed without care:

**`package-lock.json` is committed on purpose.** `actions/setup-node` with
`cache: npm` needs it to compute the cache key, and `npm ci` needs it to install
reproducibly. It was in `.gitignore` upstream; if the lock drifts from
`package.json`, `npm ci` refuses to run.

**`vsce` does not create the parent directory** of the `-o` output path. The
workflow runs `mkdir -p dist` first. Without it packaging aborts with `ENOENT`.

**`docs/images/` ships inside the `.vsix`.** Marketplaces render the README from
the package itself, so excluding the screenshots would show broken images on the
listing page. `docs/RELEASING.md` and other maintainer docs are excluded via
`.vscodeignore`.

---

## Verifying a release

```bash
# confirm the tag is on the remote
git ls-remote origin refs/tags/v0.1.0

# list releases and assets
curl -s https://api.github.com/repos/jjb4150/mysql-custom/releases \
  | grep -E '"tag_name"|"browser_download_url"'

# inspect the packaged vsix without installing it
python -c "
import zipfile, json
z = zipfile.ZipFile('mysql-custom-0.1.0.vsix')
pkg = json.loads(z.read('extension/package.json'))
print(pkg['publisher'] + '.' + pkg['name'], pkg['version'])
print(len(z.namelist()), 'files')
"
```

Then install the downloaded `.vsix` with
`code --install-extension mysql-custom-<version>.vsix --force` and confirm the
extension loads.

---

## Local build

```bash
npm ci
npx tsc --noEmit
npx webpack --mode=production
npx @vscode/vsce package --no-dependencies -o ../mysql-custom.vsix
```

After installing, reload the window (`Ctrl+Shift+P` → **Developer: Reload
Window**) — the extension only picks up new code on activation.

### Verify what you shipped

`out/extension.js` is the node-side bundle; `out/webview/js/query.js` holds the
result-view UI. Both are worth checksumming across the repo, the installed
extension directory, and the `.vsix`:

```bash
md5sum out/webview/js/query.js
md5sum ~/.vscode/extensions/junbiaojin.mysql-custom-<version>/out/webview/js/query.js
python -c "
import zipfile, hashlib
z = zipfile.ZipFile('mysql-custom.vsix')
print(hashlib.md5(z.read('extension/out/webview/js/query.js')).hexdigest())
"
```

A mismatch means you are looking at a stale install.

---

## Versioning

`0.x.y` while the interaction design is still moving. Bump to `1.0.0` when the
command surface and configuration keys are considered stable.

Changing `name` in `package.json` changes the extension ID, which changes
`globalStoragePath` — existing connections stored in VS Code's `state.vscdb`
under the old ID will not be picked up. Migrating requires copying the storage
directory **and** inserting a row under the new key. Avoid renaming after a
public release.