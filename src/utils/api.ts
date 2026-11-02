/**
 * 站点信息、登录状态与主题设置
 *
 * 对应 CF-Server-Monitor 的 GET /api/config。
 * 保留主题原有的 MeInfo / PublicSettings 结构，界面代码按原样读取。
 */

import { ADMIN_HISTORY_HOURS, fetchMe, HubError, loadThemeConfig, PUBLIC_HISTORY_HOURS } from '@/utils/hub'

/** CFSM 当前公开访问模式不代表访客已登录 */
export interface MeInfo {
  logged_in: boolean
  username: string
}

/** 公开站点属性 */
export interface PublicSettings {
  sitename: string
  /** 公开状态页是否开放 */
  public_page: boolean
  /** CFSM 公开 API 当前支持的延迟历史查询小时数 */
  ping_record_preserve_time?: number
  /** CFSM 公开 API 当前支持的负载历史查询小时数 */
  record_preserve_time?: number
  /** 站长在面板里保存的主题设置，已按 theme.json 补齐默认值 */
  theme_settings?: Record<string, unknown> | null
}

export class ApiError extends Error {
  code: number

  constructor(code: number, message: string) {
    super(message)
    this.name = 'ApiError'
    this.code = code
  }
}

function toApiError(error: unknown): unknown {
  if (error instanceof HubError)
    return new ApiError(error.status, error.message)
  return error
}

export class HubApi {
  private mePromise: Promise<Awaited<ReturnType<typeof fetchMe>>> | null = null

  private me() {
    // getMe 与 getPublicSettings 在启动时并行调用，共用一次请求
    if (!this.mePromise) {
      this.mePromise = fetchMe().finally(() => {
        setTimeout(() => {
          this.mePromise = null
        }, 1000)
      })
    }
    return this.mePromise
  }

  async getMe(): Promise<MeInfo> {
    try {
      const me = await this.me()
      return { logged_in: me.authed === true, username: me.authed ? '站长' : '' }
    }
    catch (error) {
      throw toApiError(error)
    }
  }

  async getPublicSettings(): Promise<PublicSettings> {
    const [meResult, config] = await Promise.all([
      this.me().catch(() => null),
      loadThemeConfig(),
    ])
    const hours = meResult?.authed ? ADMIN_HISTORY_HOURS : PUBLIC_HISTORY_HOURS
    return {
      sitename: meResult?.site_name || 'Monitor',
      public_page: meResult?.public_page !== false,
      ping_record_preserve_time: hours,
      record_preserve_time: hours,
      theme_settings: config,
    }
  }
}

let sharedApi: HubApi | null = null

export function getSharedApi(): HubApi {
  if (!sharedApi)
    sharedApi = new HubApi()
  return sharedApi
}
