import { SearchClient } from "../src/infrastructure/search/client"

const count = Number(process.env.SEARCH_MESSAGES ?? 1000)
const characters = Number(process.env.SEARCH_MESSAGE_CHARACTERS ?? 10_000)
const documents = Array.from({ length: count }, (_, index) => ({
  id: String(index),
  text: "worker refresh unrelated content foo.bar ".repeat(Math.ceil(characters / 40)) + ` unique-${index}`,
}))
const client = new SearchClient()
try {
  const start = performance.now()
  const built = await client.request({ id: 1, documents, query: "foo.bar refresh" })
  const buildAndFirstQueryMs = performance.now() - start
  const samples: number[] = []
  for (let index = 0; index < 25; index++) {
    const start = performance.now()
    await client.request({ id: index + 2, query: index % 2 ? "unique-999" : "foo.bar", excerptId: "500" })
    samples.push(performance.now() - start)
  }
  samples.sort((a, b) => a - b)
  console.log(JSON.stringify({ messages: count, characters: documents.reduce((total, document) => total + document.text.length, 0),
    hits: built.hits.length, buildAndFirstQueryMs, queryP50Ms: samples[Math.floor(samples.length * .5)],
    queryP95Ms: samples[Math.floor(samples.length * .95)], rssMiB: process.memoryUsage().rss / 1024 / 1024,
  }, null, 2))
} finally { await client.close() }
