# Extension lifecycle

Pi App treats package changes as a deployment, not as a direct `npm install`
from the WebView.

## Invariants

1. `install`, `update`, `remove`, `uninstall`, enable and disable are serialized.
2. A new agent cannot start while an extension generation is changing.
3. Idle extension hosts are restarted automatically. A streaming turn or
   queued/running background task is never interrupted; the mutation is
   rejected with a retryable message.
4. Global operations run in an empty management workspace so they cannot
   accidentally read or update packages from the directory that launched the
   desktop app.
5. Project operations carry explicit project approval and snapshot only the
   selected project scope plus any global scope that Pi itself will update.
6. npm lifecycle scripts are disabled. Extension code is validated after
   installation, but an install hook would run before validation and could
   produce side effects that a package-tree rollback cannot undo.
7. The Advanced JSON editor cannot mutate `packages`; Library is the sole
   owner of that field. Other settings writes share the lifecycle mutex and
   cannot race a package transaction.

## Transaction

`src-tauri/src/extension_lifecycle.rs` performs:

1. recovery of an interrupted prior transaction;
2. clone-on-write snapshot of `settings.json`, `npm`, and `git` for every
   affected scope (`cp -cR` on APFS, recursive copy fallback);
3. the real Pi package-manager command;
4. declarative vendor overlays from `extension-overlays/`;
5. a real offline `pi --mode rpc` boot;
6. command/tool source-contract checks for the harness and its known
   integrations;
7. commit, or complete rollback on any non-zero exit, unknown overlay anchor,
   load failure, missing capability, or source collision.

The journal lives under
`~/.pi/agent/.pi-app-extension-transactions/<transaction>/journal.json`.
Application startup restores every non-committed journal before the Supervisor
can spawn an agent. A crash between filesystem steps therefore prefers the
last known-good generation.

This follows the extension-host model used by VS Code: activation changes
require an extension-host restart, while disabling is persistent and does not
mean uninstalling the package. It adds a fail-closed compatibility gate and
rollback because Pi packages share one mutable npm/git store.

## Vendor overlays

An overlay is data, not an updater-specific shell hook. The current
`pi-subagents-worktree-cwd-v1` manifest contains:

- the package-relative root;
- target file;
- already-applied marker;
- exact accepted upstream anchor;
- replacement.

Every install/update re-applies it. If upstream already contains the marker it
is idempotent. If neither marker nor accepted anchor exists, the new package is
unknown and the whole transaction rolls back. Updating an overlay for a new
upstream release is therefore an explicit reviewed compatibility change.

The legacy maintenance command reads the same manifest:

```sh
npm run patch:pi-subagents
npm run check:pi-subagents
```

## Verification

Fast deterministic coverage:

```sh
cargo test --manifest-path src-tauri/Cargo.toml --lib
npm test
npm run build
```

Opt-in real Pi coverage:

```sh
cargo test --manifest-path src-tauri/Cargo.toml \
  live_extension_health_gate_loads_the_real_harness_surface --lib -- --ignored
cargo test --manifest-path src-tauri/Cargo.toml \
  real_transaction_installs_valid_extension_and_commits --lib -- --ignored
cargo test --manifest-path src-tauri/Cargo.toml \
  incompatible_vendor_update_rolls_back_the_complete_generation --lib -- --ignored
cargo test --manifest-path src-tauri/Cargo.toml \
  project_scoped_install_and_disable_never_touch_global_packages --lib -- --ignored
cargo test --manifest-path src-tauri/Cargo.toml \
  real_three_package_update_passes_transaction_and_overlay_gate --lib -- --ignored
```

