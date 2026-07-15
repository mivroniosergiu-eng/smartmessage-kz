export type SendErrorClass =
  | 'transient'
  | 'rate_limit'
  | 'restricted'
  | 'banned'
  | 'auth_terminal'
  | 'invalid_recipient'
  | 'unknown'

/** Классификация ошибки отправки WhatsApp в стратегию обработки. Чистая функция. */
export function classifySendError(err: unknown): SendErrorClass {
  const anyErr = err as {
    message?: unknown
    statusCode?: unknown
    code?: unknown
    reason?: unknown
    status?: unknown
  } | null
  const msg = (typeof err === 'string' ? err : String(anyErr?.message ?? '')).toLowerCase()
  const code = anyErr?.statusCode ?? anyErr?.code
  const signal =
    `${String(code ?? '')} ${String(anyErr?.reason ?? '')} ${String(anyErr?.status ?? '')} ${msg}`.toLowerCase()
  if (!msg && code == null && anyErr?.reason == null && anyErr?.status == null) return 'unknown'
  if (
    /account[_ -]?banned|permanent(?:ly)?[_ -]?(?:banned|blocked)|number[_ -]?banned/.test(signal)
  ) {
    return 'banned'
  }
  if (/account[_ -]?restricted|temporar(?:y|ily)[_ -]?(?:restricted|blocked)/.test(signal)) {
    return 'restricted'
  }
  if (/rate|too many|429/.test(msg) || code === 429) return 'rate_limit'
  if (/logged ?out|unauthorized|401/.test(msg) || code === 401) return 'auth_terminal'
  if (/not.*regist|invalid.*number|no.*whatsapp/.test(msg)) return 'invalid_recipient'
  if (
    /timeout|session_error|bad mac|econnreset|socket|disconnect|conflict|replaced|503/.test(msg) ||
    code === 503
  ) {
    return 'transient'
  }
  return 'unknown'
}

/** Стоит ли повторять отправку для данного класса ошибки. */
export function isRetryable(cls: SendErrorClass): boolean {
  return cls === 'transient' || cls === 'rate_limit'
}
