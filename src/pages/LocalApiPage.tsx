import { useCallback, useEffect, useState } from 'react'
import { Alert, Button, Description, Input, Label, Switch, TextField, Typography, toast } from '@heroui/react'
import { Copy } from '@gravity-ui/icons'
import { APP_NAME } from '../brand'

type Status = {
  running: boolean
  host: string
  port: number
  enabled: boolean
  token: string
  lastError: string
}

export default function LocalApiPage() {
  const [status, setStatus] = useState<Status | null>(null)
  const [portInput, setPortInput] = useState('5034')
  const [busy, setBusy] = useState(false)

  const refresh = useCallback(async () => {
    const next = await window.electronAPI.localApi.getStatus()
    setStatus(next)
    setPortInput(String(next.port || 5034))
  }, [])

  useEffect(() => { void refresh() }, [refresh])

  const baseUrl = `http://127.0.0.1:${status?.port || 5034}`
  const example = `curl -H "Authorization: Bearer ${status?.token || '<token>'}" ${baseUrl}/v1/sessions`

  const copy = async (text: string, ok: string) => {
    await navigator.clipboard.writeText(text)
    toast.success(ok)
  }

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-5 py-2">
      <div>
        <Typography type="h3">本地 API</Typography>
        <Description>
          给本机脚本 / Cursor 读取{APP_NAME}聊天记录。只监听 127.0.0.1，必须带密钥。默认关闭，不会出网。
        </Description>
      </div>

      <Alert status="warning">
        <Alert.Indicator />
        <Alert.Content>
          <Alert.Description>
            不要改成 0.0.0.0，也不要做端口转发。开了等于本机程序能读你的聊天。
          </Alert.Description>
        </Alert.Content>
      </Alert>

      <div className="flex items-center justify-between gap-4 rounded-2xl border border-border p-4">
        <div>
          <div className="text-base font-semibold">启用本地 HTTP 接口</div>
          <div className="text-sm text-muted">{status?.running ? `已在 ${baseUrl} 监听` : '当前未启动'}</div>
        </div>
        <Switch
          isSelected={Boolean(status?.enabled)}
          isDisabled={busy}
          onChange={async (selected) => {
            setBusy(true)
            try {
              const result = await window.electronAPI.localApi.setEnabled(Boolean(selected))
              if (!result.success) toast.danger(result.error || '操作失败')
              await refresh()
            } finally {
              setBusy(false)
            }
          }}
        >
          <Switch.Control><Switch.Thumb /></Switch.Control>
        </Switch>
      </div>

      <TextField>
        <Label>端口</Label>
        <Input
          value={portInput}
          onChange={(e) => setPortInput(e.target.value)}
          onBlur={async () => {
            const port = Number(portInput)
            if (!Number.isFinite(port) || port === status?.port) return
            setBusy(true)
            try {
              const result = await window.electronAPI.localApi.setPort(port)
              if (!result.success) toast.danger(result.error || '端口无效')
              await refresh()
            } finally {
              setBusy(false)
            }
          }}
        />
      </TextField>

      <div className="flex flex-col gap-2">
        <Label>密钥</Label>
        <div className="flex gap-2">
          <Input readOnly value={status?.token || ''} />
          <Button variant="tertiary" onPress={() => status?.token && copy(status.token, '已复制密钥')}>
            <Copy width={14} height={14} />
          </Button>
          <Button
            variant="tertiary"
            isDisabled={busy}
            onPress={async () => {
              setBusy(true)
              try {
                await window.electronAPI.localApi.rotateToken()
                await refresh()
                toast.success('已更换密钥')
              } finally {
                setBusy(false)
              }
            }}
          >
            更换
          </Button>
        </div>
      </div>

      <div className="flex flex-col gap-2">
        <Label>示例</Label>
        <pre className="overflow-x-auto rounded-xl bg-surface-secondary p-3 text-xs">{example}</pre>
        <Button variant="tertiary" className="w-fit" onPress={() => copy(example, '已复制示例')}>复制示例</Button>
      </div>

      <Description>
        接口：GET /health、GET /v1/me、GET /v1/sessions、GET /v1/sessions/会话ID/messages
      </Description>
      {status?.lastError ? <Description className="text-danger">{status.lastError}</Description> : null}
    </div>
  )
}
