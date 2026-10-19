# Pinned avatar source assets

`final/` is the supplied v0.7 FINAL release: 96 character SVGs (four characters × six colors × four tiers), 63 prop SVGs, 96 static poses, geometry/palette metadata, two normative specs and the reference demo. Production copies of all 255 SVGs are verified byte-for-byte. The manifest paths are relative to this directory; run `shasum -a 256 -c SHA256SUMS` here.

Current normative snapshots: [MOTION-SPEC](./spec/MOTION-SPEC-v0.7-final.md) and [visual spec](./spec/SPEC-v0.7-final.md). Source files remain unchanged.

`compact-16px-hook/` is the historical 2026-10-17 compact silhouette revision, formerly named `compact-v0.7/`; it is unrelated to this release and no longer used at runtime. The old motion spec is retained in `spec/history/` so historical AV-00 pins remain reproducible. The old compiled product task is historical; current v0.7 visual inputs take precedence for this update.
