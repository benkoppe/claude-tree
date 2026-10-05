/** Nested providers must not report their own sessions into the host Herdr pane. */
export function providerEnvironment(environment: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const nested = { ...environment }
  for (const key of ["HERDR_ENV", "HERDR_BIN_PATH", "HERDR_SOCKET_PATH", "HERDR_PANE_ID", "HERDR_TAB_ID", "HERDR_WORKSPACE_ID"]) {
    delete nested[key]
  }
  return nested
}
