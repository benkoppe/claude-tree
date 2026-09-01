import packageJson from "../package.json" with { type: "json" }

export const PROGRAM_NAME = packageJson.name
export const PROGRAM_VERSION = packageJson.version
export const PROCESS_TITLE_PREFIX = "c/t"
