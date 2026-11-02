/**
 * 极简探针 hub 数据层
 *
 * 主题只使用 hub 公开的五个读取接口：
 *   CF-Server-Monitor: GET /api/config、GET /api/servers、GET /api/history/all、GET /api/ws
 * 这里把 hub 的节点快照转换成主题组件原本使用的 Client / NodeStatus 结构，
 * 其余界面代码因此不需要感知数据来自哪一种后端。
 *
 * 字段一律按「这个 key 可能不存在」处理：匿名访问时地址、备注等字段根本不存在，
 * 离线节点 metrics 为 null，刚连上的节点 online 为 true 但 metrics 仍为 null。
 */

import type { Client, NodeStatus } from '@/utils/rpc'
import manifest from '../../theme.json'

// 提前声明供节点字段转换使用的正则，避免使用位置早于定义。
const LOAD_AVG_SPLIT_REGEX = /[ ,]+/
const TRAFFIC_LIMIT_REGEX = /^([\d.]+)\s*(B|KB|MB|GB|TB)$/i
const TRAFFIC_UNIT_MULTIPLIERS: Record<'B' | 'KB' | 'MB' | 'GB' | 'TB', number> = {
  B: 1,
  KB: 1024,
  MB: 1024 ** 2,
  GB: 1024 ** 3,
  TB: 1024 ** 4,
}

// ==================== hub 响应类型 ====================

export interface HubMe {
  authed: boolean
  github?: boolean
  site_name?: string
  public_page?: boolean
  site?: string
}

export interface HubMetrics {
  uptime?: number
  cpu?: number
  load?: number[]
  gpu?: number
  mem_total?: number
  mem_used?: number
  swap_total?: number
  swap_used?: number
  disk_total?: number
  disk_used?: number
  net_rx?: number
  net_tx?: number
  tcp?: number
  udp?: number
  procs?: number
  total_rx?: number
  total_tx?: number
  month_rx?: number
  month_tx?: number
}

export interface HubNode {
  id: string | number
  name: string
  country?: string
  group?: string
  sort?: number
  public?: boolean
  online?: boolean
  last_seen?: number
  metrics?: HubMetrics | null
  os?: string
  kernel?: string
  arch?: string
  virt?: string
  cpu_name?: string
  gpu_name?: string
  cpu_cores?: number
  mem_total?: number
  swap_total?: number
  disk_total?: number
  agent_version?: string
  price?: number
  currency?: string
  billing_cycle?: string
  expires_at?: string | null
  expires_in?: number | null
  traffic_limit?: number
  traffic_mode?: string
  traffic_reset_day?: number
  total_rx?: number
  total_tx?: number
  month_rx?: number
  month_tx?: number
  month_used?: number
  month_start?: number
  day_rx?: number
  day_tx?: number
  // 仅登录后存在
  hostname?: string
  ipv4?: string
  ipv6?: string
  addresses?: Array<{ address: string, source: string }>
  remark?: string
  tags?: string
}

export interface HubSnapshot {
  nodes: HubNode[]
  admin?: boolean
}

export interface HubMetricRow {
  ts: number
  cpu: number
  mem_used: number
  disk_used: number
  net_rx: number
  net_tx: number
  net_rx_max?: number
  net_tx_max?: number
  disk_read_bps?: number
  disk_write_bps?: number
  disk_read_iops?: number
  disk_write_iops?: number
  disk_await_ms?: number
  disk_util?: number
  gpu_info?: string | Array<Record<string, any>> | null
}

export interface HubPingRow {
  task_id: number
  ts: number
  latency: number | null
  band?: [number, number]
  loss?: number
}

export interface HubHistory {
  metrics: HubMetricRow[]
  ping: HubPingRow[]
  probes: Record<string, string>
  loss: Record<string, number>
}

// ==================== 错误 ====================

export class HubError extends Error {
  constructor(public status: number, message: string) {
    super(message)
    this.name = 'HubError'
  }
}

async function readError(res: Response): Promise<HubError> {
  let text = ''
  try {
    text = (await res.text()).trim()
  }
  catch {}
  return new HubError(res.status, text || `HTTP ${res.status}`)
}

async function getJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  const res = await fetch(url, { credentials: 'same-origin', signal, headers: { accept: 'application/json' } })
  if (!res.ok)
    throw await readError(res)
  return await res.json() as T
}

// ==================== 基础读取 ====================

export const THEME_SHORT = manifest.short

let cfWsTimeoutMinutes = 0

export function getFrontendWsTimeoutMinutes(): number {
  return cfWsTimeoutMinutes
}

export async function fetchMe(signal?: AbortSignal): Promise<HubMe> {
  const config = await getJson<{ site_title?: string, is_public?: boolean, authorization?: boolean, frontend_ws_timeout_minutes?: number }>('/api/config', signal)
  // CFSM 的 authorization 表示当前请求是否通过 JWT / cfsm_auth Cookie 验证；
  // getJson 使用 same-origin credentials，同域主题可安全复用后台登录 Cookie。
  const timeout = Number(config.frontend_ws_timeout_minutes)
  cfWsTimeoutMinutes = Number.isFinite(timeout) ? Math.min(1440, Math.max(0, timeout)) : 0
  return { authed: config.authorization === true, site_name: config.site_title || 'CF-Server-Monitor', public_page: config.is_public !== false }
}

let cfServerIds: string[] = []
let cfSysConfig: Record<string, any> = {}

/** 判断节点是否来自 CF-Server-Monitor，避免误请求旧探针历史接口。 */
export function isCfServer(id: string | number): boolean {
  return cfServerIds.includes(String(id))
}
const cfPingHistory = new Map<string, HubHistory>()

const CF_PROBE_FIELDS = [
  { id: 1, ping: 'ping_ct', loss: 'loss_ct', config: 'custom_ct_name', fallback: '电信' },
  { id: 2, ping: 'ping_cu', loss: 'loss_cu', config: 'custom_cu_name', fallback: '联通' },
  { id: 3, ping: 'ping_cm', loss: 'loss_cm', config: 'custom_cm_name', fallback: '移动' },
  { id: 4, ping: 'ping_bd', loss: 'loss_bd', config: 'custom_bd_name', fallback: 'BGP' },
  { id: 5, ping: 'ping_node_1', loss: 'loss_node_1', config: 'node_1_name', fallback: '节点 1' },
  { id: 6, ping: 'ping_node_2', loss: 'loss_node_2', config: 'node_2_name', fallback: '节点 2' },
  { id: 7, ping: 'ping_node_3', loss: 'loss_node_3', config: 'node_3_name', fallback: '节点 3' },
  { id: 8, ping: 'ping_node_4', loss: 'loss_node_4', config: 'node_4_name', fallback: '节点 4' },
] as const

function buildCurrentPingHistory(raw: Record<string, any>, sysConfig: Record<string, any>): HubHistory {
  const probes: Record<string, string> = {}
  const loss: Record<string, number> = {}
  const ping: HubPingRow[] = []
  const sampleLoss = new Map<number, number[]>()
  const windowFields = [
    { id: 1, key: 'ct' },
    { id: 2, key: 'cu' },
    { id: 3, key: 'cm' },
    { id: 4, key: 'bd' },
  ] as const
  const lossByTimestamp = new Map<number, Record<string, unknown>>()
  if (Array.isArray(raw.loss)) {
    for (const point of raw.loss) {
      const tsValue = Number(point?.ts)
      if (Number.isFinite(tsValue) && tsValue > 0)
        lossByTimestamp.set(tsValue, point)
    }
  }

  // 优先使用列表接口提供的真实时间窗口数据，保留每个探测点的原始时间戳。
  if (Array.isArray(raw.ping)) {
    for (const point of raw.ping) {
      const tsValue = Number(point?.ts)
      if (!Number.isFinite(tsValue) || tsValue <= 0)
        continue
      const ts = tsValue > 1e12 ? tsValue / 1000 : tsValue
      const lossPoint = lossByTimestamp.get(tsValue)
      for (const probe of windowFields) {
        const value = point?.[probe.key]
        if (value === false || value === undefined)
          continue
        if (value !== null && !(typeof value === 'number' && Number.isFinite(value)))
          continue
        const nameField = CF_PROBE_FIELDS[probe.id - 1]
        if (!nameField)
          continue
        const configuredName = sysConfig[nameField.config]
        const name = typeof configuredName === 'string' && configuredName.trim()
          ? configuredName.trim()
          : nameField.fallback
        probes[String(probe.id)] = name
        const lossValue = lossPoint?.[probe.key]
        const row: HubPingRow = { task_id: probe.id, ts, latency: value }
        if (typeof lossValue === 'number' && Number.isFinite(lossValue)) {
          row.loss = lossValue
          const values = sampleLoss.get(probe.id) ?? []
          values.push(lossValue)
          sampleLoss.set(probe.id, values)
        }
        ping.push(row)
      }
    }
  }

  const rawTimestamp = raw.last_updated ?? raw.timestamp
  const parsed = typeof rawTimestamp === 'string' && !Number.isFinite(Number(rawTimestamp))
    ? Date.parse(rawTimestamp)
    : Number(rawTimestamp)
  const currentTs = Number.isFinite(parsed) && parsed > 0
    ? (parsed > 1e12 ? parsed / 1000 : parsed)
    : Date.now() / 1000

  // 最新单值字段用于窗口未开启/无历史点时兜底，也用于 4 个自定义探测节点。
  for (const probe of CF_PROBE_FIELDS) {
    if (ping.some(row => row.task_id === probe.id))
      continue
    const value = raw[probe.ping]
    const lossValue = raw[probe.loss]
    if (value === false || value === undefined)
      continue
    if (value !== null && !(typeof value === 'number' && Number.isFinite(value)))
      continue
    const name = typeof sysConfig[probe.config] === 'string' && sysConfig[probe.config].trim()
      ? sysConfig[probe.config].trim()
      : probe.fallback
    probes[String(probe.id)] = name
    const row: HubPingRow = { task_id: probe.id, ts: currentTs, latency: value }
    if (typeof lossValue === 'number' && Number.isFinite(lossValue)) {
      row.loss = lossValue
      sampleLoss.set(probe.id, [lossValue])
    }
    ping.push(row)
  }

  for (const [id, values] of sampleLoss) {
    if (values.length)
      loss[String(id)] = values.reduce((sum, value) => sum + value, 0) / values.length
  }

  return { metrics: [], ping: ping.sort((a, b) => a.ts - b.ts), probes, loss }
}

/** 将 CFSM 单台服务器响应转换为主题内部节点结构。 */
function mapCfServer(raw: Record<string, any>): HubNode {
  const id = String(raw.id)
  const num = (v: unknown) => {
    const n = typeof v === 'string' ? Number(v) : v
    return typeof n === 'number' && Number.isFinite(n) ? n : 0
  }
  const text = (v: unknown) => typeof v === 'string' ? v : ''
  // CFSM reports RAM / Swap / Disk capacities in MiB; the theme's formatBytes expects bytes.
  const mib = (v: unknown) => num(v) * 1024 * 1024
  let gpuItems: Array<Record<string, any>> = []
  if (Array.isArray(raw.gpu_info)) {
    gpuItems = raw.gpu_info
  }
  else if (typeof raw.gpu_info === 'string' && raw.gpu_info.trim()) {
    try {
      const parsed = JSON.parse(raw.gpu_info)
      if (Array.isArray(parsed))
        gpuItems = parsed
    }
    catch {
      gpuItems = []
    }
  }
  const gpuUsages = gpuItems.map(item => item.info == null || item.info === '' ? Number.NaN : Number(item.info)).filter(value => Number.isFinite(value))
  const gpuAverage = gpuUsages.length ? gpuUsages.reduce((sum, value) => sum + value, 0) / gpuUsages.length : undefined
  const gpuName = gpuItems.map(item => typeof item.name === 'string' ? item.name.trim() : '').filter(Boolean).join(', ')
  const onlineValue = raw.is_online ?? raw.online
  const online = onlineValue === true || onlineValue === 1 || onlineValue === '1'
  const rawTimestamp = raw.last_updated ?? raw.timestamp
  const timestampValue = typeof rawTimestamp === 'string' && !Number.isFinite(Number(rawTimestamp))
    ? Date.parse(rawTimestamp)
    : num(rawTimestamp)
  const timestamp = Number.isFinite(timestampValue) ? timestampValue : 0
  const load = Array.isArray(raw.load_avg)
    ? raw.load_avg.map(Number).filter(Number.isFinite)
    : typeof raw.load_avg === 'string' ? raw.load_avg.trim().split(LOAD_AVG_SPLIT_REGEX).map(Number).filter(Number.isFinite) : []
  const trafficText = text(raw.traffic_limit)
  const match = trafficText.match(TRAFFIC_LIMIT_REGEX)
  const trafficUnit = match?.[2]?.toUpperCase() as keyof typeof TRAFFIC_UNIT_MULTIPLIERS | undefined
  const trafficLimit = match && trafficUnit
    ? Number(match[1]) * TRAFFIC_UNIT_MULTIPLIERS[trafficUnit]
    : num(raw.traffic_limit)
  return {
    id,
    name: text(raw.name) || id,
    country: text(raw.region),
    group: text(raw.server_group),
    sort: num(raw.sort_order),
    public: !(raw.is_hidden === true || raw.is_hidden === 1 || raw.is_hidden === '1'),
    online,
    last_seen: timestamp > 1e12 ? timestamp / 1000 : timestamp,
    os: text(raw.os),
    kernel: text(raw.kernel_version),
    arch: text(raw.arch),
    cpu_name: text(raw.cpu_info),
    gpu_name: gpuName,
    cpu_cores: num(raw.cpu_cores),
    mem_total: mib(raw.ram_total),
    swap_total: mib(raw.swap_total),
    disk_total: mib(raw.disk_total),
    agent_version: text(raw.agent_version),
    price: num(raw.price),
    currency: text(raw.currency),
    billing_cycle: text(raw.billing_cycle),
    expires_at: text(raw.expire_date) || null,
    // CFSM 使用逗号分隔标签；主题内部 tagHelper 使用分号分隔。
    tags: text(raw.tags).split(',').map(tag => tag.trim()).filter(Boolean).join(';'),
    traffic_limit: trafficLimit,
    traffic_mode: text(raw.traffic_calc_type) || 'sum',
    traffic_reset_day: num(raw.reset_day),
    total_rx: num(raw.net_rx),
    total_tx: num(raw.net_tx),
    month_rx: num(raw.net_rx_monthly),
    month_tx: num(raw.net_tx_monthly),
    // CFSM 的 ip_v4 / ip_v6 是可达性标记（'0'/'1'），不是 IP 地址；公共 API 不暴露真实公网 IP。
    // 不把标记 '1' 传给 GeoIP 查询或当作节点地址显示。
    ipv4: '',
    ipv6: '',
    metrics: {
      cpu: raw.cpu == null ? Number.NaN : num(raw.cpu),
      load,
      gpu: gpuAverage,
      mem_total: mib(raw.ram_total),
      mem_used: mib(raw.ram_used),
      swap_total: mib(raw.swap_total),
      swap_used: mib(raw.swap_used),
      disk_total: mib(raw.disk_total),
      disk_used: mib(raw.disk_used),
      net_rx: num(raw.net_in_speed),
      net_tx: num(raw.net_out_speed),
      tcp: num(raw.tcp_conn),
      udp: num(raw.udp_conn),
      procs: num(raw.processes),
      total_rx: num(raw.net_rx),
      total_tx: num(raw.net_tx),
      month_rx: num(raw.net_rx_monthly),
      month_tx: num(raw.net_tx_monthly),
    },
  }
}

/** 详情页按需读取单台节点，不把单节点响应当作全量列表。 */
export async function fetchNodeDetail(id: string | number, signal?: AbortSignal): Promise<HubSnapshot> {
  const response = await getJson<Record<string, any>>(`/api/server?id=${encodeURIComponent(String(id))}`, signal)
  const raw = response.server && typeof response.server === 'object' ? response.server : response
  if (!raw || (typeof raw.id !== 'string' && typeof raw.id !== 'number'))
    throw new HubError(502, 'Invalid server detail response')
  const sysConfig = response.sysConfig && typeof response.sysConfig === 'object' ? response.sysConfig : {}
  cfSysConfig = sysConfig
  const node = mapCfServer(raw)
  if (!cfServerIds.includes(String(node.id)))
    cfServerIds.push(String(node.id))
  const history = buildCurrentPingHistory(raw, sysConfig)
  cfPingHistory.set(String(node.id), history)
  rememberProbes(history)
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('cfsm:node-history-updated', { detail: { id: String(node.id) } }))
  }
  return { nodes: [node] }
}

export async function fetchNodes(signal?: AbortSignal): Promise<HubSnapshot> {
  const data = await getJson<{ servers?: Array<Record<string, any>>, sysConfig?: Record<string, any> }>('/api/servers', signal)
  const sysConfig = data.sysConfig && typeof data.sysConfig === 'object' ? data.sysConfig : {}
  cfSysConfig = sysConfig
  const nodes: HubNode[] = (Array.isArray(data.servers) ? data.servers : []).map(mapCfServer)
  cfServerIds = nodes.map(node => String(node.id))
  cfPingHistory.clear()
  for (const raw of Array.isArray(data.servers) ? data.servers : []) {
    const id = String(raw.id)
    const history = buildCurrentPingHistory(raw, sysConfig)
    cfPingHistory.set(id, history)
    rememberProbes(history)
  }
  return { nodes }
}

// ---- 主题设置 ----

interface ConfigField {
  key?: string
  type: string
  default?: unknown
  options?: Array<{ value: string }>
  min?: number
  max?: number
}

/** theme.json 中声明的设置项（去掉分组标题） */
export const configFields = (manifest.config as ConfigField[]).filter(
  (field): field is ConfigField & { key: string } => field.type !== 'title' && typeof field.key === 'string',
)

/** 与面板同一套取值检查：保存的值可能来自旧版本主题，对不上的当作没保存过 */
function fits(field: ConfigField, value: unknown): boolean {
  switch (field.type) {
    case 'boolean':
      return typeof value === 'boolean'
    case 'number':
      return typeof value === 'number' && Number.isFinite(value)
        && value >= (field.min ?? Number.NEGATIVE_INFINITY) && value <= (field.max ?? Number.POSITIVE_INFINITY)
    case 'select':
      return !!field.options?.some(option => option.value === value)
    default:
      return typeof value === 'string'
  }
}

/**
 * 读取站点级主题设置：theme.json 默认值 + hub 中站长保存的值。
 * 401、404 与网络错误一律按默认值渲染，不报错。
 */
export async function loadThemeConfig(): Promise<Record<string, unknown>> {
  let saved: Record<string, unknown> = {}
  try {
    const body = await getJson<{ theme_options?: Record<string, unknown> }>('/api/config')
    if (body.theme_options && typeof body.theme_options === 'object')
      saved = body.theme_options
  }
  catch {
    // 配置接口不可用时仍使用主题默认值
  }
  return Object.fromEntries(configFields.map(field => [field.key, fits(field, saved[field.key]) ? saved[field.key] : field.default]))
}

/** CFSM 历史 API：匿名访问最多 24 小时；已验证管理员可查询至 168 小时（7 天）。 */
export const PUBLIC_HISTORY_HOURS = 24
export const ADMIN_HISTORY_HOURS = 168

export interface HistoryQuery {
  hours: number
  points?: number
  series?: 'metrics' | 'ping'
}

const historyCache = new Map<string, { at: number, promise: Promise<HubHistory> }>()
const HISTORY_CACHE_MS = 15_000

export function fetchNodeHistory(id: string | number, query: HistoryQuery, signal?: AbortSignal): Promise<HubHistory> {
  // CFSM 仅接受固定 hours 档位；请求较大档位后，再按调用方要求的窗口在本地裁剪。
  const requestedHours = Math.min(168, Math.max(1, Number.isFinite(query.hours) ? query.hours : 1))
  const apiHours = [0.167, 0.5, 1, 6, 12, 24, 48, 96, 168].find(value => value >= requestedHours) ?? 168
  const url = `/api/history/all?id=${encodeURIComponent(String(id))}&hours=${apiHours}`
  const cacheKey = `${url}|window=${requestedHours}`
  const cached = historyCache.get(cacheKey)
  if (cached && Date.now() - cached.at < HISTORY_CACHE_MS)
    return cached.promise
  const promise = (async () => {
    const rows = await getJson<Array<Record<string, any>>>(url, signal)
    const num = (v: unknown) => {
      const n = typeof v === 'string' ? Number(v) : v
      return typeof n === 'number' && Number.isFinite(n) ? n : Number.NaN
    }
    const cutoffMs = Date.now() - requestedHours * 3_600_000
    const timestampMs = (row: Record<string, any>) => {
      const value = row.timestamp
      const parsed = typeof value === 'string' && !Number.isFinite(Number(value)) ? Date.parse(value) : num(value)
      return parsed > 1e12 ? parsed : parsed * 1000
    }
    const historyRows = (Array.isArray(rows) ? rows : []).filter((row) => {
      const ts = timestampMs(row)
      return Number.isFinite(ts) && ts >= cutoffMs
    })
    const metrics = historyRows.map(row => ({
      ts: (() => {
        const value = row.timestamp
        const parsed = typeof value === 'string' && !Number.isFinite(Number(value)) ? Date.parse(value) : num(value)
        return parsed > 1e12 ? parsed / 1000 : parsed
      })(),
      cpu: num(row.cpu),
      mem_used: num(row.ram_used) * 1024 * 1024,
      disk_used: num(row.disk_used) * 1024 * 1024,
      net_rx: num(row.net_in_speed ?? row.net_rx),
      net_tx: num(row.net_out_speed ?? row.net_tx),
      disk_read_bps: num(row.disk_read_bps),
      disk_write_bps: num(row.disk_write_bps),
      disk_read_iops: num(row.disk_read_iops),
      disk_write_iops: num(row.disk_write_iops),
      disk_await_ms: num(row.disk_await_ms),
      disk_util: num(row.disk_util),
      gpu_info: row.gpu_info ?? null,
    })).filter(row => Number.isFinite(row.ts) && row.ts > 0)
    // CFSM 历史行也包含固定的运营商 / 自定义 Ping 字段；只转换真实存在的采样。
    const probes: Record<string, string> = {}
    const lossSamples = new Map<number, number[]>()
    const ping: HubPingRow[] = []
    for (const field of CF_PROBE_FIELDS) {
      const configuredName = cfSysConfig[field.config]
      const name = typeof configuredName === 'string' && configuredName.trim() ? configuredName.trim() : field.fallback
      let hasSample = false
      for (const row of historyRows) {
        const rawValue = row[field.ping]
        if (rawValue === false || rawValue === 'false' || rawValue === undefined)
          continue
        const ts = timestampMs(row) / 1000
        if (!Number.isFinite(ts) || ts <= 0)
          continue
        let latency: number | null
        if (rawValue === null) {
          latency = null
        }
        else {
          const parsedValue = num(rawValue)
          if (!Number.isFinite(parsedValue))
            continue
          latency = parsedValue
        }
        hasSample = true
        const rowPing: HubPingRow = { task_id: field.id, ts, latency }
        const rawLoss = row[field.loss]
        const parsedLoss = rawLoss === false || rawLoss === 'false' || rawLoss === undefined || rawLoss === null
          ? Number.NaN
          : num(rawLoss)
        // 与指标查询的规则一致：明确超时按 100%，有效 RTT 且无丢包样本按 0%。
        rowPing.loss = Number.isFinite(parsedLoss) ? parsedLoss : (latency === null ? 100 : 0)
        const values = lossSamples.get(field.id) ?? []
        values.push(rowPing.loss)
        lossSamples.set(field.id, values)
        ping.push(rowPing)
      }
      if (hasSample)
        probes[String(field.id)] = name
    }

    // 与 /api/servers 的近期窗口合并，按探测 ID + 时间戳去重，保留真实上报时间。
    const current = cfPingHistory.get(String(id))
    const pingKeys = new Set(ping.map(row => `${row.task_id}:${row.ts}`))
    for (const row of current?.ping ?? []) {
      const key = `${row.task_id}:${row.ts}`
      if (row.ts * 1000 < cutoffMs || pingKeys.has(key))
        continue
      ping.push(row)
      pingKeys.add(key)
      const values = lossSamples.get(row.task_id) ?? []
      values.push(row.loss ?? (row.latency === null ? 100 : 0))
      lossSamples.set(row.task_id, values)
    }
    for (const [probeId, name] of Object.entries(current?.probes ?? {}))
      probes[probeId] ??= name
    const loss: Record<string, number> = {}
    for (const [probeId, values] of lossSamples) {
      if (values.length)
        loss[String(probeId)] = values.reduce((sum, value) => sum + value, 0) / values.length
    }
    for (const [probeId, value] of Object.entries(current?.loss ?? {}))
      loss[probeId] ??= value

    return { metrics, ping: ping.sort((a, b) => a.ts - b.ts), probes, loss } satisfies HubHistory
  })()
  historyCache.set(cacheKey, { at: Date.now(), promise })
  promise.catch(() => {
    if (historyCache.get(cacheKey)?.promise === promise)
      historyCache.delete(cacheKey)
  })
  return promise
}

// ==================== 延迟监控名称 ====================

/** 已见过的延迟监控，按 hub 返回的先后顺序（即面板里的顺序）排列 */
const knownProbes = new Map<number, string>()

export function rememberProbes(history: HubHistory): void {
  // ping 行按面板顺序排列，先按行出现顺序登记，再补上没有数据的监控
  for (const row of history.ping) {
    const name = history.probes[String(row.task_id)]
    if (!knownProbes.has(row.task_id))
      knownProbes.set(row.task_id, name ?? `监控 ${row.task_id}`)
  }
  for (const [id, name] of Object.entries(history.probes)) {
    const numericId = Number(id)
    if (Number.isFinite(numericId))
      knownProbes.set(numericId, name)
  }
}

export function getKnownProbes(): Array<{ id: number, name: string }> {
  return Array.from(knownProbes.entries(), ([id, name]) => ({ id, name }))
}

// ==================== 字段转换 ====================

const COUNTRY_CODE_REGEX = /^[A-Z]{2}$/
const MONTH_CYCLE_REGEX = /^\d+m$/
const DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/
const ISO_CURRENCY_REGEX = /^[A-Z]{3}$/

function num(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

/** ISO 3166 两位代码 → 旗帜 emoji（主题的地区工具以 emoji 为键） */
export function countryToFlag(code: string | undefined): string {
  const cc = (code ?? '').trim().toUpperCase()
  if (!COUNTRY_CODE_REGEX.test(cc))
    return ''
  return String.fromCodePoint(...Array.from(cc, ch => 0x1F1E6 + ch.charCodeAt(0) - 65))
}

const CURRENCY_SYMBOL: Record<string, string> = {
  CNY: '¥',
  USD: '\u0024',
  JPY: '¥',
  HKD: 'HK\u0024',
  EUR: '€',
  GBP: '£',
  RUB: '₽',
  CHF: '₣',
  INR: '₹',
  VND: '₫',
  THB: '฿',
  CAD: 'CA\u0024',
}

/** hub 的币种是三位 ISO 代码；主题按「符号 + 金额」显示，未收录的代码保留原样并加空格 */
export function currencySymbol(code: string | undefined): string {
  const raw = (code ?? '').trim()
  if (!raw)
    return '¥'
  const cc = raw.toUpperCase()
  // CF-Server-Monitor 的 currency 可能直接返回 ¥、$、HK$ 等符号，
  // 也可能返回 CNY、USD 等 ISO 代码；符号应原样保留。
  if (!ISO_CURRENCY_REGEX.test(cc))
    return raw
  return CURRENCY_SYMBOL[cc] ?? `${cc} `
}

const NAMED_CYCLE_MONTHS: Record<string, number> = {
  // CFSM API billing_cycle values
  month: 1,
  quarter: 3,
  half_year: 6,
  year: 12,
  two_years: 24,
  three_years: 36,
  four_years: 48,
  five_years: 60,
  // Legacy theme / hub aliases
  monthly: 1,
  quarterly: 3,
  semiannual: 6,
  semi_annual: 6,
  yearly: 12,
  annual: 12,
  biennial: 24,
  triennial: 36,
  quinquennial: 60,
}

/** hub 付款周期（monthly / 60m / once…）→ 主题使用的天数，-1 表示一次性 */
export function billingCycleDays(cycle: string | undefined): number {
  const value = (cycle ?? '').trim()
  if (value === 'once')
    return -1
  const months = NAMED_CYCLE_MONTHS[value] ?? (MONTH_CYCLE_REGEX.test(value) ? Number(value.slice(0, -1)) : Number.NaN)
  if (!Number.isFinite(months) || months <= 0)
    return 30
  switch (months) {
    case 1: return 30
    case 3: return 90
    case 6: return 180
    case 12: return 365
    case 24: return 730
    case 36: return 1095
    case 60: return 1825
    default: return Math.round(months * 30.4375)
  }
}

/**
 * 到期时间。优先用 hub 按自己的日历算好的 expires_in（0 为今天到期，负数为已过期天数），
 * 不拿 expires_at 按访客时钟算，避免访客时区不同导致在线节点提前显示「已过期」。
 *
 * 主题按 ceil(剩余毫秒 / 一天) 显示天数，所以这里构造一个剩余 (N-1, N] 天的时刻：
 * 以当前整点为锚加 N 天。锚在整点上，每轮轮询得到的字符串不变，不会触发重渲染。
 * 今天到期（0）按剩余不足一天处理，显示为临近到期而不是已过期。
 * 旧 hub 没有 expires_in 时才按 expires_at 自己算。null 表示没有到期日。
 */
export function expiryMoment(node: HubNode): string {
  if (node.expires_in !== undefined) {
    if (node.expires_in === null || !Number.isFinite(node.expires_in))
      return ''
    const anchor = new Date()
    anchor.setMinutes(0, 0, 0)
    const days = node.expires_in === 0 ? 23 / 24 : node.expires_in
    return new Date(anchor.getTime() + days * 86_400_000).toISOString()
  }
  const date = str(node.expires_at)
  if (!DATE_REGEX.test(date))
    return ''
  return new Date(`${date}T23:59:59`).toISOString()
}

const TRAFFIC_MODES = new Set(['up', 'down', 'max', 'sum'])

export function hubNodeToClient(node: HubNode): Client {
  const v4 = node.addresses?.find(item => !item.address.includes(':'))?.address ?? str(node.ipv4)
  const v6 = node.addresses?.find(item => item.address.includes(':'))?.address ?? str(node.ipv6)
  return {
    uuid: String(node.id),
    name: str(node.name) || `#${node.id}`,
    cpu_name: str(node.cpu_name),
    gpu_name: str(node.gpu_name) || undefined,
    virtualization: str(node.virt),
    arch: str(node.arch),
    cpu_cores: num(node.cpu_cores),
    os: str(node.os),
    kernel_version: str(node.kernel),
    ipv4: v4 || undefined,
    ipv6: v6 || undefined,
    region: countryToFlag(node.country),
    remark: str(node.remark) || undefined,
    public_remark: '',
    mem_total: num(node.mem_total),
    swap_total: num(node.swap_total),
    disk_total: num(node.disk_total),
    version: str(node.agent_version) || undefined,
    weight: num(node.sort),
    price: num(node.price),
    billing_cycle: billingCycleDays(node.billing_cycle),
    auto_renewal: false,
    currency: currencySymbol(node.currency),
    expired_at: expiryMoment(node),
    group: str(node.group),
    tags: str(node.tags),
    hidden: node.public === false,
    traffic_limit: num(node.traffic_limit),
    traffic_limit_type: TRAFFIC_MODES.has(str(node.traffic_mode)) ? str(node.traffic_mode) : 'sum',
    created_at: '',
    updated_at: '',
  }
}

/** 指标完整时返回它，缺失或格式不对时返回 null，由调用方显示为「不可用」 */
function usableMetrics(metrics: HubNode['metrics']): HubMetrics | null {
  if (!metrics || typeof metrics !== 'object' || Array.isArray(metrics))
    return null
  if (typeof metrics.cpu !== 'number' || !Number.isFinite(metrics.cpu))
    return null
  return metrics
}

export function hubNodeToStatus(node: HubNode): NodeStatus {
  const metrics = usableMetrics(node.metrics)
  const load = Array.isArray(metrics?.load) ? metrics.load : []
  const lastSeen = num(node.last_seen)
  return {
    client: String(node.id),
    time: lastSeen > 0 ? new Date(lastSeen * 1000).toISOString() : '',
    cpu: num(metrics?.cpu),
    gpu: typeof metrics?.gpu === 'number' && Number.isFinite(metrics.gpu) ? metrics.gpu : Number.NaN,
    ram: num(metrics?.mem_used),
    ram_total: num(metrics?.mem_total, num(node.mem_total)),
    swap: num(metrics?.swap_used),
    swap_total: num(metrics?.swap_total, num(node.swap_total)),
    load: num(load[0]),
    load5: num(load[1]),
    load15: num(load[2]),
    temp: 0,
    disk: num(metrics?.disk_used),
    disk_total: num(metrics?.disk_total, num(node.disk_total)),
    net_in: num(metrics?.net_rx),
    net_out: num(metrics?.net_tx),
    // 本期（按流量重置日）流量，与 traffic_limit 配额对应
    net_total_up: num(node.month_tx, num(metrics?.month_tx)),
    net_total_down: num(node.month_rx, num(metrics?.month_rx)),
    // hub 记录以来的累计流量
    traffic_up: num(node.total_tx, num(metrics?.total_tx)),
    traffic_down: num(node.total_rx, num(metrics?.total_rx)),
    process: num(metrics?.procs),
    connections: num(metrics?.tcp),
    connections_udp: num(metrics?.udp),
    online: node.online === true,
    uptime: num(metrics?.uptime),
    // 已连接但尚未上报，或上报的数据不完整
    message: node.online === true && !metrics ? 'unavailable' : undefined,
  }
}

export function snapshotToMaps(snapshot: HubSnapshot): { clients: Record<string, Client>, statuses: Record<string, NodeStatus> } {
  const clients: Record<string, Client> = {}
  const statuses: Record<string, NodeStatus> = {}
  for (const node of snapshot.nodes) {
    if (!node || (typeof node.id !== 'number' && typeof node.id !== 'string'))
      continue
    try {
      const uuid = String(node.id)
      clients[uuid] = hubNodeToClient(node)
      statuses[uuid] = hubNodeToStatus(node)
    }
    catch (error) {
      // 单个节点的坏数据不影响其他节点
      console.warn('[CFSM] skipped malformed node', node, error)
    }
  }
  return { clients, statuses }
}

// ==================== WebSocket ====================

export interface LiveSocketHandlers {
  onSnapshot: (snapshot: HubSnapshot) => void
  onOpen?: () => void
  onClose?: (event: CloseEvent) => void
}

/** 详情页仅订阅当前服务器；收到增量推送后合并一次该节点 REST 快照。 */
export function openNodeLiveSocket(id: string, onUpdate: () => void, onOpen?: () => void, onClose?: (event: CloseEvent) => void): WebSocket {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
  const socket = new WebSocket(`${protocol}//${location.host}/api/ws?subscribe=${encodeURIComponent(id)}`)
  socket.addEventListener('open', () => onOpen?.())
  socket.addEventListener('message', (event) => {
    if (typeof event.data !== 'string')
      return
    try {
      const message = JSON.parse(event.data)
      if (message?.type !== 'batchUpdate' || !Array.isArray(message.updates))
        return
      if (message.updates.some((update: { serverId?: string }) => String(update.serverId) === id))
        onUpdate()
    }
    catch (error) {
      console.warn('[CFSM] detail websocket frame error', error)
    }
  })
  socket.addEventListener('close', event => onClose?.(event))
  return socket
}

/** 订阅 /api/ws：hub 每 2 秒推送一次与 /api/nodes 相同的快照 */
export function openLiveSocket(handlers: LiveSocketHandlers): WebSocket {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
  const socket = new WebSocket(`${protocol}//${location.host}/api/ws?subscribe=all`)
  socket.addEventListener('open', () => {
    socket.send(JSON.stringify({ type: 'subscribe', scope: 'all', ids: cfServerIds }))
    handlers.onOpen?.()
  })
  socket.addEventListener('message', async (event) => {
    if (typeof event.data !== 'string')
      return
    try {
      const data = JSON.parse(event.data)
      if (data?.type === 'batchUpdate' || data?.type === 'update' || Array.isArray(data?.servers))
        handlers.onSnapshot(await fetchNodes())
    }
    catch (error) {
      console.warn('[CFSM] websocket frame error', error)
    }
  })
  socket.addEventListener('close', event => handlers.onClose?.(event))
  return socket
}
