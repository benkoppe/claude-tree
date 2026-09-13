import { expect, test } from "bun:test"
import { runSubprocess } from "./subprocess"

test("sets the Bun and OS-visible process titles", async () => {
  const title = "c/t: process title check"
  const script = `
    import { setProcessTitle } from ${JSON.stringify(new URL("../src/process-title.ts", import.meta.url).href)}
    setProcessTitle(${JSON.stringify(title)})
    const comm = process.platform === "linux"
      ? (await Bun.file("/proc/self/comm").text()).trim()
      : undefined
    console.log(JSON.stringify({ title: process.title, comm }))
  `
  const [exitCode, stdout, stderr] = await runSubprocess([process.execPath, "-e", script])

  expect(stderr).toBe("")
  expect(exitCode).toBe(0)
  expect(JSON.parse(stdout)).toEqual({
    title,
    ...(process.platform === "linux" ? { comm: Buffer.from(title).subarray(0, 15).toString() } : {}),
  })
})
