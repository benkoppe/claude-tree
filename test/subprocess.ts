const EXECUTION_TIMEOUT_MS = 4_000
const EXIT_TIMEOUT_MS = 500

export async function runSubprocess(
  command: string[],
  options: { cwd?: string; env?: Record<string, string | undefined> } = {},
): Promise<[number, string, string]> {
  const child = Bun.spawn(command, { ...options, stdin: "ignore", stdout: "pipe", stderr: "pipe" })
  try {
    return await within(
      Promise.all([child.exited, Bun.readableStreamToText(child.stdout), Bun.readableStreamToText(child.stderr)]),
      EXECUTION_TIMEOUT_MS,
      "Test subprocess timed out",
    )
  } finally {
    try {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL")
      await within(child.exited, EXIT_TIMEOUT_MS, "Test subprocess did not exit after cleanup")
    } finally {
      child.unref()
    }
  }
}

async function within<A>(promise: Promise<A>, timeoutMs: number, message: string): Promise<A> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}
