const INVALID_BASE_URL_MESSAGE =
  'PLAYWRIGHT_BASE_URL must use http with an explicit port from 1 to 65535'

export function resolvePlaywrightWebServerPort(baseURL: string): string {
  try {
    const parsedBaseURL = new URL(baseURL)
    const port = Number(parsedBaseURL.port)
    if (
      parsedBaseURL.protocol !== 'http:' ||
      parsedBaseURL.port.length === 0 ||
      !Number.isInteger(port) ||
      port < 1 ||
      port > 65_535
    ) {
      throw new Error(INVALID_BASE_URL_MESSAGE)
    }

    return parsedBaseURL.port
  } catch {
    throw new Error(INVALID_BASE_URL_MESSAGE)
  }
}
