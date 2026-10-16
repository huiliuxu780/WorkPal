# Pinned avatar source assets

`final/` contains byte-for-byte copies of the supplied implementation SVGs: four full characters, four original compact 16px characters, the prop SVGs, and the eye-bound reference. It is preserved as the source baseline. `compact-v0.7/` contains the approved replacement 16px set. Verify both sets with SHA256SUMS. AV-02 may copy the `compact-v0.7/` SVG bytes into production; 24px and larger use the unchanged full SVGs in `final/`.

The compiled avatar spec and MOTION-SPEC v0.6 FINAL are pinned by SHA-256 in [AV-00-decision.md](../AV-00-decision.md). They are not copied into the repository because their originals include local identity/path details prohibited by project policy. Do not edit the originals or silently alter the SVG paths.

The supplied compact dot and treble SVGs are identical. The user delegated the 16px revision to Codex on 2026-10-17. The versioned [compact-v0.7 acceptance note](../review/compact-v0.7-acceptance.md) records the one changed silhouette, actual-size visual evidence, and limitations. The original `final/*-16.svg` files remain unchanged for comparison.
