/** Bundled import.meta.url refers to the executable entry, not the source module. */
export const isStandaloneExecutable = Bun.isStandaloneExecutable === true || Bun.main.startsWith("/$bunfs/")

export function workerEntry(source: URL, bundledPath: string): URL {
  return isStandaloneExecutable ? new URL(`file:///$bunfs/root/${bundledPath.replace(/\.ts$/, ".js")}`) : source
}
