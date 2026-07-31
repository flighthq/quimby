/**
 * The single directory under the OS temp dir that every test — unit and integration — writes into.
 *
 * Shared by the per-worker setup (which points TMPDIR, QUIMBY_DATA_HOME and XDG_CONFIG_HOME inside
 * it) and the global setup (which sweeps it before and after a run). Kept in its own module so the
 * two cannot drift onto different paths, which would silently turn the sweep into a no-op.
 */
export const TEST_TMP_DIRNAME = 'quimby-tests'
