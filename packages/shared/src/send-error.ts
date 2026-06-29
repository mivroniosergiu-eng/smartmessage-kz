export type SendErrorClass =
  | 'transient'
  | 'rate_limit'
  | 'auth_terminal'
  | 'invalid_recipient'
  | 'unknown'

/** Классификация ошибки отправки WhatsApp в стратегию обработки. Чистая функция. */
export function classifySendError(err: unknown): SendErrorClass {
  const anyErr = err as { message?: unknown; statusCode?: unknown; code?: unknown } | null
  const msg = (typeof err === 'string' ? err : String(anyErr?.message ?? '')).toLowerCase()
  const code = anyErr?.statusCode ?? anyErr?.code
  if (!msg && code == null) return 'unknown'
  if (/rate|too many|429/.test(msg) || code === 429) return 'rate_limit'
  if (/logged ?out|conflict|replaced|unauthorized|401/.test(msg) || code === 401) return 'auth_terminal'
  if (/not.*regist|invalid.*number|no.*whatsapp/.test(msg)) return 'invalid_recipient'
  if (/timeout|session_error|bad mac|econnreset|socket|disconnect|503/.test(msg) || code === 503) {
    return 'transient'
  }
  return 'unknown'
}

/** Стоит ли повторять отправку для данного класса ошибки. */
export function isRetryable(cls: SendErrorClass): boolean {
  return cls === 'transient' || cls === 'rate_limit'
}
