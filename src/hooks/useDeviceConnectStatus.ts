import { useEffect, useState } from 'react'

export type DeviceConnectStatus = 'disconnected' | 'connecting' | 'connected' | 'error'

export type WechatBotLiveStatus = {
  status: DeviceConnectStatus
  activity: 'idle' | 'working'
  activityLabel: string
  error: string | null
}

const EMPTY: WechatBotLiveStatus = {
  status: 'disconnected',
  activity: 'idle',
  activityLabel: '\u672a\u8fde\u63a5',
  error: null,
}

export function useWechatBotLiveStatus(): WechatBotLiveStatus {
  const [live, setLive] = useState<WechatBotLiveStatus>(EMPTY)

  useEffect(() => {
    const api = window.electronAPI?.deviceConnect?.wechat
    if (!api) return
    const apply = (s: any) => {
      const status = s?.status || 'disconnected'
      setLive({
        status,
        activity: s?.activity === 'working' ? 'working' : 'idle',
        activityLabel: String(s?.activityLabel || (status === 'connected' ? '\u5728\u7ebf \u00b7 \u7a7a\u95f2' : '\u672a\u8fde\u63a5')),
        error: s?.error || null,
      })
    }
    api.getStatus().then(apply).catch(() => undefined)
    return api.onStatus(apply)
  }, [])

  return live
}

export function useDeviceConnectStatus(): DeviceConnectStatus {
  return useWechatBotLiveStatus().status
}
