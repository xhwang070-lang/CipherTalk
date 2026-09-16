declare module 'word-extractor' {
  export default class WordExtractor {
    extract(source: string | Buffer): Promise<{
      getBody: (options?: unknown) => string
      getHeaders?: () => string
      getFooters?: () => string
    }>
  }
}
