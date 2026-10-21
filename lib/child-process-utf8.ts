/**
 * Make Windows child processes emit UTF-8, matching how the shell tools decode.
 *
 * pi's shell tools run PowerShell with
 * `[Console]::OutputEncoding = UTF8` and decode the captured bytes as UTF-8.
 * That is correct for Node and for Python with `PYTHONIOENCODING=utf-8`, but a
 * Java process started on a zh-CN Windows still writes **GBK**: with a piped
 * stdout, `stdout.encoding` follows `native.encoding` (GBK), so the JVM encodes
 * 中文 as GBK bytes and the UTF-8 decoder turns them into U+FFFD — visible as
 * `10?? 20, 2026 …` in a JDBC log, and `?`/`��` in the transcript.
 *
 * PowerShell 7 does not help here: the encoding of a native child is chosen by
 * that child, not by the shell. The only reliable lever is the child's own
 * environment, so the server sets these defaults once at startup for every
 * process it spawns (shell tools, MCP servers, code-mode workers):
 *
 * - `JAVA_TOOL_OPTIONS`: JDK 19+ honours `stdout.encoding`, older JDKs honour
 *   `sun.stdout.encoding`; both are set so the fix does not depend on the JDK.
 * - `PYTHONIOENCODING`: Python's own stdout/stderr. Left alone when the user (or
 *   a model) already set it, so an explicit choice still wins.
 *
 * Costs one `Picked up JAVA_TOOL_OPTIONS: …` line on each JVM's stderr; that is
 * the JVM's own notice and is worth readable logs.
 *
 * Windows-only: elsewhere UTF-8 is already the norm.
 */

const JAVA_ENCODING_FLAGS = [
  "-Dstdout.encoding=UTF-8",
  "-Dstderr.encoding=UTF-8",
  "-Dsun.stdout.encoding=UTF-8",
  "-Dsun.stderr.encoding=UTF-8",
].join(" ");

export const UTF8_CHILD_ENV_DEFAULTS = {
  JAVA_TOOL_OPTIONS: JAVA_ENCODING_FLAGS,
  PYTHONIOENCODING: "utf-8",
} as const;

/**
 * Apply the defaults to `environment` in place and return it.
 *
 * Existing values are preserved: a user-supplied `JAVA_TOOL_OPTIONS` keeps its
 * flags and gains the encoding ones, and an existing `PYTHONIOENCODING` is not
 * overwritten (an explicit value may deliberately target a legacy consumer).
 */
export function applyUtf8ChildProcessDefaults(
  environment: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): NodeJS.ProcessEnv {
  if (platform !== "win32") return environment;

  // Windows environment names are case-insensitive; find the existing spelling
  // so we append to it instead of creating a duplicate key.
  const findKey = (name: string) => Object.keys(environment).find((key) => key.toUpperCase() === name);
  const javaKey = findKey("JAVA_TOOL_OPTIONS");
  const currentJava = javaKey ? environment[javaKey] ?? "" : "";
  // Only add flags the user has not already decided.
  const missing = JAVA_ENCODING_FLAGS.split(" ")
    .filter((flag) => !currentJava.includes(flag.split("=")[0]))
    .join(" ");
  if (missing) {
    environment[javaKey ?? "JAVA_TOOL_OPTIONS"] = [currentJava.trim(), missing].filter(Boolean).join(" ");
  }

  if (!findKey("PYTHONIOENCODING")) {
    environment.PYTHONIOENCODING = UTF8_CHILD_ENV_DEFAULTS.PYTHONIOENCODING;
  }

  return environment;
}
