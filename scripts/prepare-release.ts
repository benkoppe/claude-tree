import { appendFile } from "node:fs/promises"
import { releaseChannel, releaseVersion } from "./release-config"

const version = releaseVersion(process.env.RELEASE_VERSION ?? "")
const values = { version, tag: `v${version}`, channel: releaseChannel(version) }
if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, Object.entries(values).map(([key, value]) => `${key}=${value}\n`).join(""))
console.log(JSON.stringify(values))
