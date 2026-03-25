import type {
  AggregateExpr,
  FilterExpr,
  Uniquery,
  UniqueryControls,
  WithRelation,
} from '@uniqu/core'
import { isPrimitive } from '@uniqu/core'

/**
 * Build a URL query string from a Uniquery object.
 * Produces output compatible with `parseUrl` from `@uniqu/url`.
 *
 * @param query - The canonical query to serialize
 * @returns URL query string without leading "?"
 */
export function buildUrl(query: Uniquery): string {
  const filterStr = query.filter ? serializeFilter(query.filter) : ''
  const controlStr = query.controls ? serializeControls(query.controls) : ''
  if (filterStr && controlStr) return filterStr + '&' + controlStr
  return filterStr || controlStr
}

function serializeFilter(expr: FilterExpr): string {
  if ('$and' in expr && expr.$and !== undefined) {
    let result = ''
    for (const child of expr.$and as FilterExpr[]) {
      const s = serializeFilter(child)
      if (s) result = result ? result + '&' + s : s
    }
    return result
  }

  if ('$or' in expr && expr.$or !== undefined) {
    let result = ''
    for (const child of expr.$or as FilterExpr[]) {
      const s = serializeFilter(child)
      if (s) result = result ? result + '^' + s : s
    }
    return result
  }

  if ('$not' in expr && expr.$not !== undefined) {
    const inner = serializeFilter(expr.$not as FilterExpr)
    return inner ? `!(${inner})` : ''
  }

  // Comparison node
  let result = ''
  for (const [field, value] of Object.entries(expr as Record<string, unknown>)) {
    if (value instanceof RegExp) {
      const part = `${field}~=${serializeValue(value)}`
      result = result ? result + '&' + part : part
    } else if (isPrimitive(value)) {
      const part = `${field}=${serializeValue(value)}`
      result = result ? result + '&' + part : part
    } else {
      for (const [op, opValue] of Object.entries(value as Record<string, unknown>)) {
        const part = serializeComparison(field, op, opValue)
        result = result ? result + '&' + part : part
      }
    }
  }
  return result
}

function serializeComparison(field: string, op: string, value: unknown): string {
  switch (op) {
    case '$eq':
      return `${field}=${serializeValue(value)}`
    case '$ne':
      return `${field}!=${serializeValue(value)}`
    case '$gt':
      return `${field}>${serializeValue(value)}`
    case '$gte':
      return `${field}>=${serializeValue(value)}`
    case '$lt':
      return `${field}<${serializeValue(value)}`
    case '$lte':
      return `${field}<=${serializeValue(value)}`
    case '$regex':
      return `${field}~=${serializeValue(value)}`
    case '$in': {
      let list = ''
      for (const item of value as unknown[]) {
        const s = serializeValue(item)
        list = list ? list + ',' + s : s
      }
      return `${field}{${list}}`
    }
    case '$nin': {
      let list = ''
      for (const item of value as unknown[]) {
        const s = serializeValue(item)
        list = list ? list + ',' + s : s
      }
      return `${field}!{${list}}`
    }
    case '$exists':
      return value ? `$exists=${field}` : `$!exists=${field}`
    default:
      return `${field}${op}${serializeValue(value)}`
  }
}

function serializeValue(value: unknown): string {
  if (value === null) return 'null'
  if (value === true) return 'true'
  if (value === false) return 'false'
  if (typeof value === 'number') return String(value)
  if (value instanceof RegExp) return `'${value.toString()}'`
  if (value instanceof Date) return `'${value.toISOString()}'`
  const str = String(value)
  // Quote strings that could be misinterpreted as other types
  if (str === 'null' || str === 'true' || str === 'false') return `'${str}'`
  if (/^\d/.test(str) && !isNaN(Number(str)) && !str.startsWith('0')) return `'${str}'`
  if (str.startsWith('/') && /\/[gimsuy]*$/.test(str)) return `'${str}'`
  // Quote strings with special characters
  if (/[&^=!<>~(){},\s'\\]/.test(str)) return `'${str.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`
  return str
}

const KNOWN_CONTROL_KEYS = new Set(['$select', '$groupBy', '$having', '$sort', '$limit', '$skip', '$count', '$with'])

function serializeControls(controls: UniqueryControls): string {
  let result = ''

  if (controls.$select) {
    let seg = ''
    if (Array.isArray(controls.$select)) {
      for (const entry of controls.$select) {
        let s: string
        if (typeof entry === 'string') {
          s = entry
        } else {
          const agg = entry as AggregateExpr
          s = agg.$as ? `${agg.$fn}(${agg.$field}):${agg.$as}` : `${agg.$fn}(${agg.$field})`
        }
        seg = seg ? seg + ',' + s : s
      }
    } else {
      for (const [field, val] of Object.entries(controls.$select)) {
        const s = val === 0 ? `-${field}` : field
        seg = seg ? seg + ',' + s : s
      }
    }
    if (seg) result = `$select=${seg}`
  }

  if (controls.$groupBy?.length) {
    let seg = ''
    for (const field of controls.$groupBy) {
      seg = seg ? seg + ',' + field : field
    }
    const part = `$groupBy=${seg}`
    result = result ? result + '&' + part : part
  }

  if (controls.$having) {
    const havingStr = serializeFilter(controls.$having)
    if (havingStr) {
      const needsParens = '$and' in controls.$having
      const part = needsParens
        ? `$having=(${havingStr})`
        : `$having=${havingStr}`
      result = result ? result + '&' + part : part
    }
  }

  if (controls.$sort) {
    let seg = ''
    for (const [field, dir] of Object.entries(controls.$sort)) {
      const s = dir === -1 ? `-${field}` : field
      seg = seg ? seg + ',' + s : s
    }
    if (seg) {
      const part = `$sort=${seg}`
      result = result ? result + '&' + part : part
    }
  }

  if (controls.$limit !== undefined) {
    const part = `$limit=${controls.$limit}`
    result = result ? result + '&' + part : part
  }

  if (controls.$skip !== undefined) {
    const part = `$skip=${controls.$skip}`
    result = result ? result + '&' + part : part
  }

  if (controls.$count) {
    result = result ? result + '&$count' : '$count'
  }

  if (controls.$with) {
    let seg = ''
    for (const entry of controls.$with) {
      let s: string
      if (typeof entry === 'string') {
        s = entry
      } else {
        const rel = entry as WithRelation
        const inner = buildUrl({ filter: rel.filter, controls: rel.controls })
        s = inner ? `${rel.name}(${inner})` : rel.name
      }
      seg = seg ? seg + ',' + s : s
    }
    if (seg) {
      const part = `$with=${seg}`
      result = result ? result + '&' + part : part
    }
  }

  // Pass-through unknown $-prefixed controls
  for (const [key, value] of Object.entries(controls)) {
    if (key.startsWith('$') && !KNOWN_CONTROL_KEYS.has(key)) {
      const part = value !== undefined && value !== '' ? `${key}=${value}` : key
      result = result ? result + '&' + part : part
    }
  }

  return result
}
