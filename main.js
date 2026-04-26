#!/usr/bin/env node

const numberFormatter = new Intl.NumberFormat('en-US')

const ANALYTICS_GROUP_LIMIT = 10_000

const D1_DAILY_ROWS_READ_LIMIT = 5_000_000
const D1_DAILY_ROWS_WRITTEN_LIMIT = 100_000
const D1_MONTHLY_ROWS_READ_LIMIT = 25_000_000_000
const D1_MONTHLY_ROWS_WRITTEN_LIMIT = 50_000_000
const D1_STORAGE_BYTES_LIMIT = 5 * 1024 * 1024 * 1024
const R2_MONTHLY_CLASS_A_LIMIT = 1_000_000
const R2_MONTHLY_CLASS_B_LIMIT = 10_000_000
const R2_STORAGE_BYTES_LIMIT = 10 * 1024 * 1024 * 1024
const WORKERS_DAILY_REQUESTS_LIMIT = 100_000
const WORKERS_MONTHLY_REQUESTS_LIMIT = 10_000_000
const KV_DAILY_READS_LIMIT = 100_000
const KV_DAILY_MUTATION_LIMIT = 1_000
const KV_MONTHLY_READS_LIMIT = 10_000_000
const KV_MONTHLY_MUTATION_LIMIT = 1_000_000
const KV_STORAGE_BYTES_LIMIT = 1 * 1024 * 1024 * 1024
const QUEUES_DAILY_OPERATIONS_LIMIT = 10_000
const QUEUES_MONTHLY_OPERATIONS_LIMIT = 1_000_000
const VECTORIZE_STORED_DIMENSIONS_LIMIT = 5_000_000

const R2_CLASS_A_ACTIONS = new Set(
  [
    'ListBuckets',
    'PutBucket',
    'ListObjects',
    'PutObject',
    'CopyObject',
    'CompleteMultipartUpload',
    'CreateMultipartUpload',
    'LifecycleStorageTierTransition',
    'ListMultipartUploads',
    'UploadPart',
    'UploadPartCopy',
    'ListParts',
    'PutBucketEncryption',
    'PutBucketCors',
    'PutBucketLifecycleConfiguration',
  ].map((action) => action.toLowerCase())
)

const R2_CLASS_B_ACTIONS = new Set(
  [
    'HeadBucket',
    'HeadObject',
    'GetObject',
    'UsageSummary',
    'GetBucketEncryption',
    'GetBucketLocation',
    'GetBucketCors',
    'GetBucketLifecycleConfiguration',
  ].map((action) => action.toLowerCase())
)

const R2_FREE_ACTIONS = new Set(
  ['DeleteObject', 'DeleteBucket', 'AbortMultipartUpload'].map((action) => action.toLowerCase())
)

function getToken() {
  return (process.env.CLOUDFLARE_API_TOKEN || process.env.CF_API_TOKEN || '').trim()
}

function toUtcDateString(date) {
  return date.toISOString().slice(0, 10)
}

function getUtcMonthStart(date) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1))
}

function getNextUtcDayStart(date) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + 1))
}

function getNextUtcMonthStart(date) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1))
}

function formatCount(value) {
  return Number.isFinite(Number(value)) ? numberFormatter.format(Number(value)) : '0'
}

function formatBytes(value) {
  const bytes = Number(value) || 0
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let size = bytes
  let unitIndex = 0

  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024
    unitIndex += 1
  }

  return `${size.toFixed(unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`
}

function formatDuration(ms) {
  const totalSeconds = Math.max(0, Math.floor((Number(ms) || 0) / 1000))
  const days = Math.floor(totalSeconds / 86400)
  const hours = Math.floor((totalSeconds % 86400) / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  const parts = []

  if (days) parts.push(`${days}d`)
  if (hours || parts.length) parts.push(`${hours}h`)
  if (minutes || parts.length) parts.push(`${minutes}m`)
  parts.push(`${seconds}s`)

  return parts.join(' ')
}

function formatPercent(used, limit) {
  return limit > 0 ? `${((used / limit) * 100).toFixed(2)}%` : 'n/a'
}

function formatMetric(label, value, formatter = formatCount) {
  return {
    label,
    value: formatter(value),
  }
}

function formatLimitedMetric(label, used, limit, formatter = formatCount) {
  const normalizedUsed = Number(used) || 0
  const normalizedLimit = Number(limit) || 0
  const remaining = normalizedLimit - normalizedUsed
  const over = remaining < 0
  const remainingLabel = over
    ? `OVER by ${formatter(Math.abs(remaining))}`
    : `${formatter(remaining)} left`

  return {
    label,
    value: `${formatter(normalizedUsed)} / ${formatter(normalizedLimit)}`,
    detail: `${remainingLabel} - ${formatPercent(normalizedUsed, normalizedLimit)}`,
    over,
  }
}

function getBreakdownValue(item, period, key, field) {
  return Number(item?.[`${period}Breakdown`]?.[key]?.[field] || 0)
}

function addNumericFields(target, source = {}) {
  for (const [key, value] of Object.entries(source || {})) {
    target[key] = (Number(target[key]) || 0) + (Number(value) || 0)
  }
}

function maxNumericFields(target, source = {}) {
  for (const [key, value] of Object.entries(source || {})) {
    target[key] = Math.max(Number(target[key]) || 0, Number(value) || 0)
  }
}

function aggregateGroupsByDimension(groups, dimension, today, { valueKey = 'sum', mode = 'sum' } = {}) {
  const map = new Map()

  for (const group of Array.isArray(groups) ? groups : []) {
    const key = group?.dimensions?.[dimension] || 'account'
    const current = map.get(key) || {
      id: key,
      daily: {},
      monthly: {},
    }
    const values = group?.[valueKey] || {}
    const applyValues = mode === 'max' ? maxNumericFields : addNumericFields

    applyValues(current.monthly, values)
    if (group?.dimensions?.date === today) {
      applyValues(current.daily, values)
    }

    map.set(key, current)
  }

  return Array.from(map.values()).sort((left, right) => left.id.localeCompare(right.id))
}

function aggregateGroupsWithBreakdown(
  groups,
  dimension,
  today,
  { breakdownDimension, classifyBreakdown, valueKey = 'sum' } = {}
) {
  const map = new Map()

  for (const group of Array.isArray(groups) ? groups : []) {
    const key = group?.dimensions?.[dimension] || 'account'
    const current = map.get(key) || {
      id: key,
      daily: {},
      monthly: {},
      dailyBreakdown: {},
      monthlyBreakdown: {},
    }
    const values = group?.[valueKey] || {}
    const rawBreakdownKey = group?.dimensions?.[breakdownDimension] || 'unknown'
    const breakdownKey = classifyBreakdown ? classifyBreakdown(rawBreakdownKey) : rawBreakdownKey

    addNumericFields(current.monthly, values)
    current.monthlyBreakdown[breakdownKey] ||= {}
    addNumericFields(current.monthlyBreakdown[breakdownKey], values)

    if (group?.dimensions?.date === today) {
      addNumericFields(current.daily, values)
      current.dailyBreakdown[breakdownKey] ||= {}
      addNumericFields(current.dailyBreakdown[breakdownKey], values)
    }

    map.set(key, current)
  }

  return Array.from(map.values()).sort((left, right) => left.id.localeCompare(right.id))
}

function classifyR2ActionType(actionType) {
  const normalized = String(actionType || '').toLowerCase()

  if (R2_CLASS_A_ACTIONS.has(normalized)) {
    return 'classA'
  }

  if (R2_CLASS_B_ACTIONS.has(normalized)) {
    return 'classB'
  }

  if (R2_FREE_ACTIONS.has(normalized)) {
    return 'free'
  }

  return 'other'
}

function classifyKvActionType(actionType) {
  const normalized = String(actionType || '').toLowerCase()

  if (normalized.includes('read') || normalized.includes('get')) {
    return 'read'
  }

  if (normalized.includes('write') || normalized.includes('put')) {
    return 'write'
  }

  if (normalized.includes('delete')) {
    return 'delete'
  }

  if (normalized.includes('list')) {
    return 'list'
  }

  return 'other'
}

function hasUsageValue(value) {
  if (value === null || value === undefined) {
    return false
  }

  if (typeof value === 'number') {
    return value > 0
  }

  if (typeof value === 'object') {
    return Object.values(value).some((entry) => hasUsageValue(entry))
  }

  return Boolean(value)
}

function itemHasUsage(item) {
  return hasUsageValue(item?.daily) || hasUsageValue(item?.monthly) || hasUsageValue(item?.storage)
}

function buildResourceGroups(groups) {
  return groups
    .map((group) => ({
      ...group,
      items: (Array.isArray(group.items) ? group.items : []).filter((item) => item.id && itemHasUsage(item)),
    }))
    .filter((group) => group.items.length > 0)
}

function getTotalResources(resources) {
  return resources.reduce((total, group) => total + group.items.length, 0)
}

async function cloudflareApi(apiToken, path) {
  const response = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
    headers: {
      Authorization: `Bearer ${apiToken}`,
      'Content-Type': 'application/json',
    },
  })
  const body = await response.json().catch(() => null)

  if (!response.ok || body?.success === false) {
    const detail = body?.errors
      ?.map((entry) => `${entry?.code || ''} ${entry?.message || ''}`.trim())
      .filter(Boolean)
      .join('; ')
    throw new Error(detail || `Cloudflare API request failed with ${response.status}`)
  }

  return body.result
}

async function cloudflareGraphql(apiToken, query, variables) {
  const response = await fetch('https://api.cloudflare.com/client/v4/graphql', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query, variables }),
  })
  const body = await response.json().catch(() => null)

  if (!response.ok || body?.errors) {
    const detail = body?.errors
      ?.map((entry) => entry?.message)
      .filter(Boolean)
      .join('; ')
    throw new Error(detail || `Cloudflare GraphQL request failed with ${response.status}`)
  }

  return body.data
}

async function listScopedAccount(apiToken) {
  let accounts = []

  try {
    accounts = await cloudflareApi(apiToken, '/accounts?per_page=50')
  } catch {
    throw new Error('Token lookup needs Account Analytics:Read and Account Settings:Read scoped to one account.')
  }

  const normalizedAccounts = (Array.isArray(accounts) ? accounts : [])
    .map((account) => ({
      id: account?.id || '',
      name: account?.name || account?.id || 'Cloudflare account',
    }))
    .filter((account) => account.id)

  if (normalizedAccounts.length === 1) {
    return normalizedAccounts[0]
  }

  if (normalizedAccounts.length > 1) {
    throw new Error('Token can access multiple accounts. Scope the token to one specific account, then try again.')
  }

  throw new Error('Unable to discover a Cloudflare account from this token. Add Account Settings:Read and scope the token to one account.')
}

async function discoverAnalyticsResources({ apiToken }) {
  const account = await listScopedAccount(apiToken)
  const now = new Date()
  const today = toUtcDateString(now)
  const monthStart = toUtcDateString(getUtcMonthStart(now))
  const query = `
    query CloudflareAnalyticsResources($accountTag: string!, $start: Date!, $end: Date!) {
      viewer {
        accounts(filter: { accountTag: $accountTag }) {
          d1AnalyticsAdaptiveGroups(
            limit: ${ANALYTICS_GROUP_LIMIT}
            filter: { date_geq: $start, date_leq: $end }
            orderBy: [date_ASC]
          ) {
            dimensions { date databaseId }
            sum { readQueries writeQueries rowsRead rowsWritten queryBatchResponseBytes }
          }
          d1StorageAdaptiveGroups(
            limit: ${ANALYTICS_GROUP_LIMIT}
            filter: { date_geq: $start, date_leq: $end }
            orderBy: [date_ASC]
          ) {
            dimensions { date databaseId }
            max { databaseSizeBytes }
          }
          r2OperationsAdaptiveGroups(
            limit: ${ANALYTICS_GROUP_LIMIT}
            filter: { date_geq: $start, date_leq: $end }
            orderBy: [date_ASC]
          ) {
            dimensions { date bucketName actionType }
            sum { requests responseBytes responseObjectSize }
          }
          r2StorageAdaptiveGroups(
            limit: ${ANALYTICS_GROUP_LIMIT}
            filter: { date_geq: $start, date_leq: $end }
            orderBy: [date_ASC]
          ) {
            dimensions { date bucketName }
            max { metadataSize objectCount payloadSize uploadCount }
          }
          workersInvocationsAdaptive(
            limit: ${ANALYTICS_GROUP_LIMIT}
            filter: { date_geq: $start, date_leq: $end }
            orderBy: [date_ASC]
          ) {
            dimensions { date scriptName }
            sum { cpuTimeUs errors requests responseBodySize subrequests wallTime }
          }
          kvOperationsAdaptiveGroups(
            limit: ${ANALYTICS_GROUP_LIMIT}
            filter: { date_geq: $start, date_leq: $end }
            orderBy: [date_ASC]
          ) {
            dimensions { date namespaceId actionType }
            sum { objectBytes requests }
          }
          kvStorageAdaptiveGroups(
            limit: ${ANALYTICS_GROUP_LIMIT}
            filter: { date_geq: $start, date_leq: $end }
            orderBy: [date_ASC]
          ) {
            dimensions { date namespaceId }
            max { byteCount keyCount }
          }
          queueMessageOperationsAdaptiveGroups(
            limit: ${ANALYTICS_GROUP_LIMIT}
            filter: { date_geq: $start, date_leq: $end }
            orderBy: [date_ASC]
          ) {
            dimensions { date queueId }
            sum { billableOperations bytes }
          }
          vectorizeV2OperationsAdaptiveGroups(
            limit: ${ANALYTICS_GROUP_LIMIT}
            filter: { date_geq: $start, date_leq: $end }
            orderBy: [date_ASC]
          ) {
            count
            dimensions { date indexName }
          }
          vectorizeV2StorageAdaptiveGroups(
            limit: ${ANALYTICS_GROUP_LIMIT}
            filter: { date_geq: $start, date_leq: $end }
            orderBy: [date_ASC]
          ) {
            dimensions { date indexName }
            max { storedVectorDimensions vectorCount }
          }
          pagesFunctionsInvocationsAdaptiveGroups(
            limit: ${ANALYTICS_GROUP_LIMIT}
            filter: { date_geq: $start, date_leq: $end }
            orderBy: [date_ASC]
          ) {
            dimensions { date scriptName }
            sum { duration errors requests responseBodySize subrequests wallTime }
          }
        }
      }
    }
  `
  const data = await cloudflareGraphql(apiToken, query, {
    accountTag: account.id,
    start: monthStart,
    end: today,
  })
  const analytics = data?.viewer?.accounts?.[0] || {}
  const d1Items = aggregateGroupsByDimension(analytics.d1AnalyticsAdaptiveGroups, 'databaseId', today)
  const d1Storage = aggregateGroupsByDimension(analytics.d1StorageAdaptiveGroups, 'databaseId', today, {
    valueKey: 'max',
    mode: 'max',
  })
  const d1StorageMap = new Map(d1Storage.map((item) => [item.id, item]))

  for (const item of d1Items) {
    const storage = d1StorageMap.get(item.id)
    if (storage) {
      item.storage = storage.monthly
    }
  }

  const r2Items = aggregateGroupsWithBreakdown(analytics.r2OperationsAdaptiveGroups, 'bucketName', today, {
    breakdownDimension: 'actionType',
    classifyBreakdown: classifyR2ActionType,
  })
  const r2Storage = aggregateGroupsByDimension(analytics.r2StorageAdaptiveGroups, 'bucketName', today, {
    valueKey: 'max',
    mode: 'max',
  })
  const r2StorageMap = new Map(r2Storage.map((item) => [item.id, item]))

  for (const item of r2Items) {
    const storage = r2StorageMap.get(item.id)
    if (storage) {
      item.storage = storage.monthly
    }
  }

  const kvItems = aggregateGroupsWithBreakdown(analytics.kvOperationsAdaptiveGroups, 'namespaceId', today, {
    breakdownDimension: 'actionType',
    classifyBreakdown: classifyKvActionType,
  })
  const kvStorage = aggregateGroupsByDimension(analytics.kvStorageAdaptiveGroups, 'namespaceId', today, {
    valueKey: 'max',
    mode: 'max',
  })
  const kvStorageMap = new Map(kvStorage.map((item) => [item.id, item]))

  for (const item of kvItems) {
    const storage = kvStorageMap.get(item.id)
    if (storage) {
      item.storage = storage.monthly
    }
  }

  const vectorizeItems = aggregateGroupsByDimension(
    (analytics.vectorizeV2OperationsAdaptiveGroups || []).map((group) => ({
      ...group,
      sum: { operations: Number(group?.count || 0) },
    })),
    'indexName',
    today
  )
  const vectorizeStorage = aggregateGroupsByDimension(analytics.vectorizeV2StorageAdaptiveGroups, 'indexName', today, {
    valueKey: 'max',
    mode: 'max',
  })
  const vectorizeStorageMap = new Map(vectorizeStorage.map((item) => [item.id, item]))

  for (const item of vectorizeItems) {
    const storage = vectorizeStorageMap.get(item.id)
    if (storage) {
      item.storage = storage.monthly
    }
  }

  const resources = buildResourceGroups([
    {
      type: 'd1',
      label: 'D1 databases',
      items: d1Items,
    },
    {
      type: 'r2',
      label: 'R2 buckets',
      items: r2Items,
    },
    {
      type: 'workers',
      label: 'Workers',
      items: aggregateGroupsByDimension(analytics.workersInvocationsAdaptive, 'scriptName', today),
    },
    {
      type: 'kv',
      label: 'Workers KV namespaces',
      items: kvItems,
    },
    {
      type: 'queues',
      label: 'Queues',
      items: aggregateGroupsByDimension(analytics.queueMessageOperationsAdaptiveGroups, 'queueId', today),
    },
    {
      type: 'vectorize',
      label: 'Vectorize indexes',
      items: vectorizeItems,
    },
    {
      type: 'pages',
      label: 'Pages Functions',
      items: aggregateGroupsByDimension(analytics.pagesFunctionsInvocationsAdaptiveGroups, 'scriptName', today),
    },
  ])

  return {
    checkedAt: now.toISOString(),
    account,
    daily: {
      date: today,
      resetAt: getNextUtcDayStart(now).toISOString(),
      resetsInMs: getNextUtcDayStart(now).getTime() - now.getTime(),
    },
    monthly: {
      startDate: monthStart,
      endDate: today,
      resetAt: getNextUtcMonthStart(now).toISOString(),
      resetsInMs: getNextUtcMonthStart(now).getTime() - now.getTime(),
    },
    resources,
    resourceCount: getTotalResources(resources),
  }
}

function getResourceStats(resourceType, item) {
  const daily = item?.daily || {}
  const monthly = item?.monthly || {}
  const storage = item?.storage || {}
  const r2StorageBytes = (storage.payloadSize || 0) + (storage.metadataSize || 0)

  switch (resourceType) {
    case 'd1':
      return [
        formatLimitedMetric('Today read', daily.rowsRead, D1_DAILY_ROWS_READ_LIMIT),
        formatLimitedMetric('Today written', daily.rowsWritten, D1_DAILY_ROWS_WRITTEN_LIMIT),
        formatLimitedMetric('Month read', monthly.rowsRead, D1_MONTHLY_ROWS_READ_LIMIT),
        formatLimitedMetric('Month written', monthly.rowsWritten, D1_MONTHLY_ROWS_WRITTEN_LIMIT),
        formatLimitedMetric('Storage', storage.databaseSizeBytes, D1_STORAGE_BYTES_LIMIT, formatBytes),
      ]
    case 'r2':
      return [
        formatMetric('Today Class A', getBreakdownValue(item, 'daily', 'classA', 'requests')),
        formatLimitedMetric(
          'Month Class A',
          getBreakdownValue(item, 'monthly', 'classA', 'requests'),
          R2_MONTHLY_CLASS_A_LIMIT
        ),
        formatMetric('Today Class B', getBreakdownValue(item, 'daily', 'classB', 'requests')),
        formatLimitedMetric(
          'Month Class B',
          getBreakdownValue(item, 'monthly', 'classB', 'requests'),
          R2_MONTHLY_CLASS_B_LIMIT
        ),
        formatLimitedMetric('Storage', r2StorageBytes, R2_STORAGE_BYTES_LIMIT, formatBytes),
        formatMetric('Objects', storage.objectCount),
      ]
    case 'workers':
      return [
        formatLimitedMetric('Today requests', daily.requests, WORKERS_DAILY_REQUESTS_LIMIT),
        formatLimitedMetric('Month requests', monthly.requests, WORKERS_MONTHLY_REQUESTS_LIMIT),
        formatMetric('Today errors', daily.errors),
        formatMetric('Month errors', monthly.errors),
        formatMetric('CPU time', `${formatCount(Math.round((monthly.cpuTimeUs || 0) / 1000))} ms`, (value) => value),
      ]
    case 'kv':
      return [
        formatLimitedMetric('Today reads', getBreakdownValue(item, 'daily', 'read', 'requests'), KV_DAILY_READS_LIMIT),
        formatLimitedMetric('Today writes', getBreakdownValue(item, 'daily', 'write', 'requests'), KV_DAILY_MUTATION_LIMIT),
        formatLimitedMetric('Today deletes', getBreakdownValue(item, 'daily', 'delete', 'requests'), KV_DAILY_MUTATION_LIMIT),
        formatLimitedMetric('Today lists', getBreakdownValue(item, 'daily', 'list', 'requests'), KV_DAILY_MUTATION_LIMIT),
        formatLimitedMetric('Month reads', getBreakdownValue(item, 'monthly', 'read', 'requests'), KV_MONTHLY_READS_LIMIT),
        formatLimitedMetric('Month writes', getBreakdownValue(item, 'monthly', 'write', 'requests'), KV_MONTHLY_MUTATION_LIMIT),
        formatLimitedMetric('Month deletes', getBreakdownValue(item, 'monthly', 'delete', 'requests'), KV_MONTHLY_MUTATION_LIMIT),
        formatLimitedMetric('Month lists', getBreakdownValue(item, 'monthly', 'list', 'requests'), KV_MONTHLY_MUTATION_LIMIT),
        formatLimitedMetric('Storage', storage.byteCount, KV_STORAGE_BYTES_LIMIT, formatBytes),
        formatMetric('Keys', storage.keyCount),
      ]
    case 'queues':
      return [
        formatLimitedMetric('Today ops', daily.billableOperations, QUEUES_DAILY_OPERATIONS_LIMIT),
        formatLimitedMetric('Month ops', monthly.billableOperations, QUEUES_MONTHLY_OPERATIONS_LIMIT),
        formatMetric('Today bytes', daily.bytes, formatBytes),
        formatMetric('Month bytes', monthly.bytes, formatBytes),
      ]
    case 'vectorize':
      return [
        formatMetric('Today ops', daily.operations),
        formatMetric('Month ops', monthly.operations),
        formatMetric('Vectors', storage.vectorCount),
        formatLimitedMetric('Stored dimensions', storage.storedVectorDimensions, VECTORIZE_STORED_DIMENSIONS_LIMIT),
      ]
    case 'pages':
      return [
        formatLimitedMetric('Today requests', daily.requests, WORKERS_DAILY_REQUESTS_LIMIT),
        formatLimitedMetric('Month requests', monthly.requests, WORKERS_MONTHLY_REQUESTS_LIMIT),
        formatMetric('Today errors', daily.errors),
        formatMetric('Month errors', monthly.errors),
      ]
    default:
      return [
        formatMetric('Today', Object.values(daily).reduce((sum, value) => sum + Number(value || 0), 0)),
        formatMetric('Month', Object.values(monthly).reduce((sum, value) => sum + Number(value || 0), 0)),
      ]
  }
}

function renderText(resourceData) {
  const lines = [
    `Checked ${resourceData.checkedAt} for ${resourceData.account?.name || resourceData.account?.id}`,
    `Daily reset in ${formatDuration(resourceData.daily?.resetsInMs)}`,
    `Monthly reset in ${formatDuration(resourceData.monthly?.resetsInMs)}`,
    '',
    `${formatCount(resourceData.resourceCount)} resources with analytics`,
    `${resourceData.monthly?.startDate} through ${resourceData.monthly?.endDate} UTC`,
  ]

  if (!resourceData.resources.length) {
    lines.push('', 'No resources returned usage for this token and time window.')
    return lines.join('\n')
  }

  for (const group of resourceData.resources) {
    const items = Array.isArray(group?.items) ? group.items : []
    lines.push('', `${group.label} (${formatCount(items.length)} found)`)

    for (const item of items) {
      lines.push(`  ${item.id}`)

      for (const metric of getResourceStats(group.type, item)) {
        const detail = metric.detail ? ` (${metric.detail})` : ''
        lines.push(`    ${metric.label}: ${metric.value}${detail}`)
      }
    }
  }

  return lines.join('\n')
}

async function main() {
  const apiToken = getToken()

  if (!apiToken) {
    throw new Error('CLOUDFLARE_API_TOKEN is required.')
  }

  const resourceData = await discoverAnalyticsResources({ apiToken })
  console.log(renderText(resourceData))
}

main().catch((err) => {
  console.error(err?.message || String(err))
  process.exit(1)
})
