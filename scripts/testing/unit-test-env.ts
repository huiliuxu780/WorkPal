/**
 * Force the unit group hermetic. Classification already keeps external suites
 * out; this removes ambient credentials so an accidental import cannot reach a
 * database, Java runtime, sandbox, or live provider.
 */
for (const name of [
  "DATABASE_URL",
  "REALTIME_DATABASE_URL",
  "VERIFY_DATABASE",
  "VERIFY_PROVIDERS",
  "AGENTSCOPE_URL",
  "AGENTSCOPE_AUTH_TOKEN",
  "E2B_API_KEY",
  "DAYTONA_API_KEY",
  "BOX_API_KEY",
  "OPENROUTER_API_KEY",
  "MODEL_API_KEY",
  "COMPOSIO_API_KEY",
  "CURSOR_API_KEY",
]) {
  delete process.env[name];
}
