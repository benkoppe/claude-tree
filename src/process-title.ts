import { dlopen, FFIType, ptr } from "bun:ffi"

const PR_SET_NAME = 15

export function setProcessTitle(title: string): void {
  process.title = title
  if (process.platform === "darwin") {
    try {
      // Update the LaunchServices display name that Bun 1.3 leaves unchanged.
      Bun.spawnSync(
        ["/usr/bin/lsappinfo", "setinfo", "-app", `#${process.pid}`, `name=${title}`],
        { stdout: "ignore", stderr: "ignore" },
      )
    } catch {}
    return
  }
  if (process.platform !== "linux") return

  // Bun 1.3 only updates its in-memory title, so set Linux's OS-visible comm name too.
  for (const soname of ["libc.so.6", "libc.so"]) {
    try {
      const libc = dlopen(soname, {
        prctl: {
          args: [FFIType.i32, FFIType.ptr, FFIType.u64, FFIType.u64, FFIType.u64],
          returns: FFIType.i32,
        },
      })
      let result: number
      try {
        const name = Buffer.from(`${title}\0`, "utf8")
        result = libc.symbols.prctl(PR_SET_NAME, ptr(name), 0n, 0n, 0n)
      } finally {
        libc.close()
      }
      if (result === 0) return
    } catch {
      // Try the generic soname used by musl before falling back to process.title alone.
    }
  }
}
