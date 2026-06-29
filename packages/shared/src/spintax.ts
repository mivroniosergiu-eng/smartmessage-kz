/**
 * Spintax: {привет|здравствуйте|добрый день} -> один случайный вариант.
 * Поддерживает вложенность. RNG инъектируется для детерминированных тестов.
 */
export function spin(template: string, rng: () => number = Math.random): string {
  const innermost = /\{([^{}]*)\}/g
  let out = template
  let guard = 0
  while (/\{[^{}]*\}/.test(out)) {
    out = out.replace(innermost, (_match, body: string) => {
      const options = body.split('|')
      const idx = Math.floor(rng() * options.length)
      return options[Math.min(idx, options.length - 1)] ?? ''
    })
    if (++guard > 100) throw new Error('spintax nesting too deep')
  }
  return out
}
