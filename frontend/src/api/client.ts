export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message)
    this.name = "ApiError"
  }
}

type ApiClientOptions = {
  onUnauthorized?: () => void
}

type RequestOptions = {
  method?: string
  body?: unknown
  signal?: AbortSignal
  responseType?: "json" | "blob"
}

export class ApiClient {
  private unauthorizedNotified = false
  private readonly onUnauthorized?: () => void

  constructor(options: ApiClientOptions = {}) {
    this.onUnauthorized = options.onUnauthorized
  }

  markAuthenticated() {
    this.unauthorizedNotified = false
  }

  async request<T>(path: string, options: RequestOptions = {}): Promise<T> {
    const headers = new Headers()
    if (options.body !== undefined) headers.set("content-type", "application/json")

    let response: Response
    try {
      response = await fetch(`/api/v1${path}`, {
        method: options.method ?? "GET",
        credentials: "same-origin",
        headers,
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        signal: options.signal,
      })
    } catch (error) {
      if (error instanceof Error) throw error
      throw new Error("无法连接到后端服务", { cause: error })
    }

    if (!response.ok) {
      let message = `请求失败（${response.status}）`
      try {
        const payload = await response.json() as { detail?: string }
        if (payload.detail) message = payload.detail
      } catch {
        // Preserve the status-based fallback when the response is not JSON.
      }
      if (response.status === 401 && !this.unauthorizedNotified) {
        this.unauthorizedNotified = true
        this.onUnauthorized?.()
      }
      throw new ApiError(message, response.status)
    }

    if (options.responseType === "blob") return await response.blob() as T
    if (response.status === 204) return undefined as T
    return await response.json() as T
  }
}
