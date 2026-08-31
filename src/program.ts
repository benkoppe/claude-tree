import packageJson from "../package.json" with { type: "json" }

export const PROGRAM_NAME = packageJson.name
export const PROGRAM_VERSION = packageJson.version
