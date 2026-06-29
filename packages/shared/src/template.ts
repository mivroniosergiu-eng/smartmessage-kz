/** Рендер шаблона: {{name}} -> значение. Бросает на отсутствующую переменную (strict). */
export function renderTemplate(tpl: string, vars: Record<string, string | number>): string {
  return tpl.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_m, key: string) => {
    if (!Object.prototype.hasOwnProperty.call(vars, key)) {
      throw new Error(`missing template variable: ${key}`)
    }
    return String(vars[key])
  })
}
