import { defineConfig } from "drizzle-kit"

export default defineConfig({
  dialect: "sqlite",
  schema: "./src/infrastructure/metadata/schema.ts",
  out: "./src/infrastructure/metadata/migrations",
})
