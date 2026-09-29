// Deterministic metadata CPU fixture. No network or installer is involved.
// Import in a browser profile or emit JSON with profile-pypi-metadata.mjs.
export function syntheticProject(wheelCount = 10424) {
  return { meta: { 'api-version': '1.1' }, name: 'metadata-fixture', files:
    Array.from({ length: wheelCount }, (_, index) => {
      const filename = `metadata_fixture-${index}.0.0-cp311-cp311-manylinux_2_17_x86_64.whl`;
      return { filename,
        url: `https://files.pythonhosted.org/packages/ab/cd/${index.toString(16).padStart(60, '0')}/${filename}`,
        hashes: { sha256: index.toString(16).padStart(64, '0') },
        'requires-python': '>=3.8', yanked: index % 29 === 0 ? 'superseded fixture release' : false,
        'core-metadata': { sha256: 'b'.repeat(64) }, 'dist-info-metadata': { sha256: 'b'.repeat(64) },
        size: 1024 + index, 'upload-time': '2026-09-01T00:00:00Z' };
    }) };
}
