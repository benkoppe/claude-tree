import { cp, mkdir } from "node:fs/promises"
import { resolve } from "node:path"
import packageJson from "../package.json" with { type: "json" }
import { releaseDependencies, releaseIdentity, releaseVersion } from "./release-config"

const directory = resolve("dist", "npm")
await mkdir(`${directory}/bin`, { recursive: true })
await cp("bin/claude-tree.cjs", `${directory}/bin/claude-tree.cjs`)
await cp("LICENSE", `${directory}/LICENSE`)
await cp("README.md", `${directory}/README.md`)
const version = releaseVersion()
const identity = releaseIdentity()
await Bun.write(`${directory}/package.json`, JSON.stringify({ name: packageJson.name, version, description: packageJson.description,
  gitHead: identity.revision, claudeTreeBuild: identity,
  license: packageJson.license, repository: packageJson.repository, homepage: packageJson.homepage,
  bin: { "claude-tree": "bin/claude-tree.cjs" }, files: ["bin", "LICENSE", "README.md"], engines: { node: ">=20" },
  optionalDependencies: releaseDependencies(version),
}, null, 2) + "\n")
console.log(directory)
