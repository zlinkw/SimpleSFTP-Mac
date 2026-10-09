# Changelog

## 0.2.61

- Support verified exit reconciliation for abandoned projectInventory, projectTree and projectFileStats reads. Request identity, persisted read-only status, local owner/transport exit, and durable exit receipts are required; live requests and remote writers remain blocked.
- Advertise the supported reconciliation methods so SimpleExperiment can retain protection when connected to an older plugin.

## 0.2.42

- Added `sync.downloadMappedPaths`: one uncompressed remote tar stream carries every selected source-to-local mapping, then extraction writes each file to its own final path.
- Unsafe paths, symlinks, duplicate destinations, directories, weight files in a metrics batch, and files over the per-file limit are rejected before transfer. `sync.downloadPaths` stays path-identical.

## 0.2.18

- Removed the legacy configurable ignore command, API, state migration, and settings.
- Upload and download selection now use only their dedicated range controls; fixed safety exclusions remain internal.

## 0.2.17

- Replaced the visible ignore-rule entry with separate upload and download ranges in SimpleExperiment. Download ranges browse the remote project and persist selected paths, file types, and size limits per target.
- Remote-to-local sync now downloads only the configured range when one exists; legacy ignore handling remains available internally for existing configurations.

## 0.2.16

- Managed uploads now honor the caller's explicit file-type and size policy. Nested configuration files such as `data/datasets/*/recipe.yaml` are no longer rejected by a second hard-coded allowlist; project-boundary and plugin-state protections remain.

## 0.2.8

- Upload preview and execution now resolve the same server and remote directory. An explicit remote path overrides a saved server root; conflicting explicit paths or a changed target stop the upload before transfer.
- Server names in API requests resolve to saved profiles; unknown names fail instead of falling back to the active server.

## 0.2.7

- Replaced the Windows tar subprocess for managed uploads with a Node UTF-8/PAX tar writer; Chinese and long workspace paths no longer fail with `Can't convert a path to a wchar_t string`.

## 0.2.6

- Replaced large command-line file lists with a NUL-delimited temporary manifest passed to tar, added bounded chunk checksums, nested repository exclusion, and upload statistics.
- Added automatic read-only migration from legacy `zlk_cluster` managed state to `simple_cluster`, including target ignore state; malformed legacy files no longer block uploads.
- Added structured transfer diagnostics for timeout, cancellation, DNS/TCP, SSH authentication, forwarding, permissions, root validation, and other transport failures.
- Refreshed the public user guide and removed personal connection defaults.
