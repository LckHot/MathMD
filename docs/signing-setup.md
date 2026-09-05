# Release signing setup (one-time, ~5 minutes)

The release APK is signed in CI. The signing key lives in repository
secrets; it never touches the repository itself.

## 1. Generate a keystore (your machine, any machine with JDK 17+)

```sh
./scripts/make-keystore.sh mathmd-release.keystore <your-password>
```

(Usage: `./scripts/make-keystore.sh [keystore-path] <store-password> [alias]`,
alias defaults to `mathmd`.) **Keep the file and the password safe** —
losing the keystore means you can never update the app over an existing
installation; a new key requires uninstalling first.

## 2. Base64-encode it

```sh
base64 -w0 mathmd-release.keystore > keystore.b64
```

## 3. Put three secrets into the GitHub repository

Repository → Settings → Secrets and variables → Actions → *New repository
secret*, three times:

| Secret name            | Value                                   |
|------------------------|-----------------------------------------|
| `RELEASE_KEYSTORE_B64` | full contents of `keystore.b64`         |
| `RELEASE_KEYSTORE_PASS`| the password you chose in step 1        |
| `RELEASE_KEY_ALIAS`    | `mathmd` (or your custom alias)         |

## 4. Done — every release is signed from now on

Push a version tag and the workflow builds a signed `app-release.apk`
and attaches it to the GitHub Release:

```sh
git tag v1.0.1 && git push origin v1.0.1
```

If the secrets are missing, the release build **fails with a clear
error** instead of publishing an unsigned APK.
