import { cp, mkdir } from "node:fs/promises"
import { resolve } from "node:path"
import packageJson from "../package.json" with { type: "json" }

const directory = resolve("dist", "npm")
await mkdir(`${directory}/bin`, { recursive: true })
await cp("bin/claude-tree.cjs", `${directory}/bin/claude-tree.cjs`)
await cp("LICENSE", `${directory}/LICENSE`)
await cp("README.md", `${directory}/README.md`)
const platforms = ["linux-x64-glibc", "linux-arm64-glibc", "linux-x64-musl", "linux-arm64-musl", "darwin-x64", "darwin-arm64"]
await Bun.write(`${directory}/package.json`, JSON.stringify({ name: packageJson.name, version: packageJson.version, description: packageJson.description,
  license: packageJson.license, repository: packageJson.repository, homepage: packageJson.homepage,
  bin: { "claude-tree": "bin/claude-tree.cjs" }, files: ["bin", "LICENSE", "README.md"], engines: { node: ">=20" },
  optionalDependencies: Object.fromEntries(platforms.map((platform) => [`@claude-tree/${platform}`, packageJson.version])),
}, null, 2) + "\n")
console.log(directory)
