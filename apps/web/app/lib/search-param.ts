export type SearchParamValue = string | string[] | undefined

export function normalizeSingleSearchParam(value: SearchParamValue): string | undefined {
  return typeof value === 'string' ? value : undefined
}
