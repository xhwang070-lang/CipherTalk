import { useCallback, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Button, Card, Input, InputGroup, Label, Spinner, TextField } from '@heroui/react'
import { Magnifier } from '@gravity-ui/icons'
import TitleBar from '../components/TitleBar'

type SearchResult = {
  query: string
  contacts: Array<{ username: string; displayName: string; kind: 'person' | 'group' | 'official' }>
  messages: Array<{ sessionId: string; localId: number; excerpt: string; time: number; fileName?: string }>
  files: Array<{ sessionId: string; localId: number; excerpt: string; time: number; fileName?: string }>
}

function kindLabel(kind: string) {
  if (kind === 'group') return '群'
  if (kind === 'official') return '公众号'
  return '联系人'
}

function formatTime(value: number) {
  if (!value) return ''
  const ms = value > 1_000_000_000_000 ? value : value * 1000
  return new Date(ms).toLocaleString('zh-CN', { hour12: false })
}

export default function SearchPage() {
  const navigate = useNavigate()
  const [query, setQuery] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [result, setResult] = useState<SearchResult | null>(null)

  const runSearch = useCallback(async () => {
    const q = query.trim()
    if (!q || busy) return
    setBusy(true)
    setError('')
    try {
      const res = await window.electronAPI.chat.searchHuaji(q)
      if (!res.success || !res.result) throw new Error(res.error || '搜索失败')
      setResult(res.result)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }, [busy, query])

  const openChat = (sessionId: string, localId?: number) => {
    const params = new URLSearchParams({ session: sessionId })
    if (localId) params.set('localId', String(localId))
    navigate('/chat?' + params.toString())
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <TitleBar title="搜索" />
      <div className="min-h-0 flex-1 overflow-y-auto px-7 py-5">
        <Card className="mb-4">
          <Card.Header>
            <Card.Title>搜索聊天、人和文件</Card.Title>
            <Card.Description>在本机索引里找联系人、群、文件名、合同号。不经过助手，也不上传。</Card.Description>
          </Card.Header>
          <Card.Content className="flex gap-2">
            <TextField className="flex-1" value={query} onChange={setQuery} onKeyDown={(event) => { if (event.key === 'Enter') void runSearch() }}>
              <Label className="sr-only">搜索</Label>
              <InputGroup variant="secondary">
                <Input placeholder="人名、群名、9420004、F321、价格表.xlsx" />
              </InputGroup>
            </TextField>
            <Button isDisabled={busy || !query.trim()} onPress={() => void runSearch()}>
              {busy ? <Spinner size="sm" /> : <Magnifier width={16} height={16} />}
              搜索
            </Button>
          </Card.Content>
        </Card>
        {error && <p className="mb-4 text-sm text-danger">{error}</p>}
        {result && (
          <div className="space-y-4">
            <Card>
              <Card.Header><Card.Title>联系人 / 群</Card.Title></Card.Header>
              <Card.Content className="space-y-2">
                {result.contacts.length === 0 && <p className="text-sm text-muted">没有匹配的人或群</p>}
                {result.contacts.map((item) => (
                  <button key={item.username} className="block w-full rounded-lg px-3 py-2 text-left hover:bg-muted/40" type="button" onClick={() => openChat(item.username)}>
                    <div className="text-sm font-medium">{item.displayName}</div>
                    <div className="text-xs text-muted">{kindLabel(item.kind)}</div>
                  </button>
                ))}
              </Card.Content>
            </Card>
            <Card>
              <Card.Header><Card.Title>文件</Card.Title></Card.Header>
              <Card.Content className="space-y-2">
                {result.files.length === 0 && <p className="text-sm text-muted">索引里没有匹配的文件名。没点开过的附件可能还不在索引里。</p>}
                {result.files.map((item) => (
                  <button key={item.sessionId + item.localId} className="block w-full rounded-lg px-3 py-2 text-left hover:bg-muted/40" type="button" onClick={() => openChat(item.sessionId, item.localId)}>
                    <div className="text-sm font-medium">{item.fileName || '文件'}</div>
                    <div className="text-xs text-muted">{item.excerpt} {formatTime(item.time)}</div>
                  </button>
                ))}
              </Card.Content>
            </Card>
            <Card>
              <Card.Header><Card.Title>消息</Card.Title></Card.Header>
              <Card.Content className="space-y-2">
                {result.messages.length === 0 && <p className="text-sm text-muted">已索引的聊天里没有这条。新会话要先打开过才会进索引。</p>}
                {result.messages.map((item) => (
                  <button key={item.sessionId + ':' + item.localId} className="block w-full rounded-lg px-3 py-2 text-left hover:bg-muted/40" type="button" onClick={() => openChat(item.sessionId, item.localId)}>
                    <div className="text-sm">{item.excerpt || '消息'}</div>
                    <div className="text-xs text-muted">{formatTime(item.time)}</div>
                  </button>
                ))}
              </Card.Content>
            </Card>
          </div>
        )}
      </div>
    </div>
  )
}
