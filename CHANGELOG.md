# Changelog

## 0.2.104

- Synced the shared staged-slot lifecycle from the Windows business authority: before a claim, only the oldest committed slot of the current identity/lane is reclaimed in place once its terminal age reaches the threshold (default one day, never configurable below it). The journal `terminalAt` is the accepted time source; unreadable, malformed, future or self-contradictory times count as not expired. Mac exposes the same two controls as `simpleSftpMac.autoReclaimExpiredCommittedSlots` and `simpleSftpMac.stagedSlotCommittedExpiryMs`; still no background or global scan and no new deletion entry point.
- Synced the user-confirmed early release: `stagedJournal.requireExpired` separates automatic expiry from a single user confirmation, freezes into the preview ledger and digest preimage, and skips only the final age rule while the slot lock is held. Shape, identity, generation, committed status, per-field format, `terminalAt` monotonicity, the under-lock binding re-check and every corruption check stay in force, so an absent flag keeps the previous expiry behaviour exactly.
- Synced the remaining shared semantics: transfer-busy snapshot projection, cleanup observe/isolate batch limits, busy fail-closed isolation with the isolation-completion receipt, background maintenance-delete admission, cleanup consumer-root binding, local staging containment and per-lane staging identity.
- Handoff markers are now written to `simple_cluster/state/simple-sftp/handoff/` in the remote project; a legacy marker at the remote project root is read at most once only when the new location is genuinely absent, is never written, restored or transferred, and a damaged marker in the new location never falls back.
- Mac identity is unchanged: `simple-local.simple-sftp-mac`, `simpleSftpMac.*` settings, `simple-sftp-mac-api`, Mac authentication, POSIX paths, update lease and Darwin handle evidence are retained. This batch was verified by source-level three-way merge and parse checks only; macOS runtime, M5 credentials and real transfers remain unverified.

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
