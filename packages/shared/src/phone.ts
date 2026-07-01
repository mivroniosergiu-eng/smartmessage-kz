/** Нормализация телефонных номеров Казахстана в формат E.164 (+7XXXXXXXXXX). */

/** Бросает, если номер не является валидным мобильным номером Казахстана. */
export function normalizePhone(raw: string): string {
  if (typeof raw !== 'string') throw new TypeError('phone must be a string')
  const digits = raw.replace(/\D/g, '')
  let national: string
  if (digits.length === 11 && (digits.startsWith('8') || digits.startsWith('7'))) {
    national = digits.slice(1)
  } else if (digits.length === 10) {
    national = digits
  } else {
    throw new Error(`invalid KZ phone: ${raw}`)
  }
  if (national.length !== 10 || !national.startsWith('7')) {
    throw new Error(`invalid KZ mobile number: ${raw}`)
  }
  return '+7' + national
}

/** Безопасная проверка валидности без исключений. */
export function isValidPhone(raw: string): boolean {
  try {
    normalizePhone(raw)
    return true
  } catch {
    return false
  }
}
