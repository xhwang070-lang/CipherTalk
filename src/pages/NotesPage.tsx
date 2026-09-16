import { useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Button, Card, Input, InputGroup, Label, TextField } from '@heroui/react'
import { FolderOpen, Plus, TrashBin } from '@gravity-ui/icons'
import TitleBar from '../components/TitleBar'

type MemoItem = { id: string; title: string; body: string; person?: string; orderNo?: string; updatedAt: string; path: string }
type SummaryItem = { fileName: string; title: string; sessionId?: string; conversationId?: number; created?: string; path: string }

export default function NotesPage() {
  const navigate = useNavigate()
  const [memos, setMemos] = useState<MemoItem[]>([])
  const [summaries, setSummaries] = useState<SummaryItem[]>([])
  const [directory, setDirectory] = useState('')
  const [title, setTitle] = useState('')
  const [person, setPerson] = useState('')
  const [orderNo, setOrderNo] = useState('')
  const [body, setBody] = useState('')
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    const [memoRes, summaryRes] = await Promise.all([
      window.electronAPI.memory.listMemos(50),
      window.electronAPI.memory.listChatSummaries(30),
    ])
    if (memoRes.success) {
      setMemos((memoRes.memos || []) as MemoItem[])
      setDirectory(memoRes.directory || '')
    }
    if (summaryRes.success) setSummaries((summaryRes.summaries || []) as SummaryItem[])
  }, [])

  useEffect(() => { void load() }, [load])

  const save = async () => {
    setError('')
    const res = await window.electronAPI.memory.writeMemo({ title, body, person, orderNo })
    if (!res.success) {
      setError(res.error || '保存失败')
      return
    }
    setTitle('')
    setPerson('')
    setOrderNo('')
    setBody('')
    await load()
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <TitleBar title="备忘" />
      <div className="min-h-0 flex-1 overflow-y-auto px-7 py-5 space-y-4">
        <Card>
          <Card.Header>
            <Card.Title>按人 / 按单备忘</Card.Title>
            <Card.Description>
              只存在本机 memory-bank/huaji-memos，以后可以拷进 Obsidian。不会上传聊天。
            </Card.Description>
          </Card.Header>
          <Card.Content className="space-y-3">
            <TextField value={title} onChange={setTitle}>
              <Label>标题</Label>
              <InputGroup variant="secondary"><Input placeholder="某某 报价 或 合同号" /></InputGroup>
            </TextField>
            <div className="grid gap-3 sm:grid-cols-2">
              <TextField value={person} onChange={setPerson}>
                <Label>人 / 群</Label>
                <InputGroup variant="secondary"><Input placeholder="可选" /></InputGroup>
              </TextField>
              <TextField value={orderNo} onChange={setOrderNo}>
                <Label>单号</Label>
                <InputGroup variant="secondary"><Input placeholder="可选，如 9420004" /></InputGroup>
              </TextField>
            </div>
            <TextField value={body} onChange={setBody}>
              <Label>内容</Label>
              <InputGroup variant="secondary"><InputGroup.TextArea placeholder="货期、金额、待核事项。看不清就写待核。" rows={4} /></InputGroup>
            </TextField>
            {error && <p className="text-sm text-danger">{error}</p>}
            <div className="flex gap-2">
              <Button isDisabled={!title.trim()} onPress={() => void save()}><Plus width={16} height={16} />记下</Button>
              {directory && (
                <Button variant="secondary" onPress={() => { void window.electronAPI.shell.openPath(directory) }}>
                  <FolderOpen width={16} height={16} />打开备忘目录
                </Button>
              )}
            </div>
          </Card.Content>
        </Card>

        {memos.map((item) => (
          <Card key={item.id}>
            <Card.Header className="flex-row items-start justify-between">
              <div>
                <Card.Title>{item.title}</Card.Title>
                <Card.Description>{[item.person, item.orderNo, item.updatedAt].filter(Boolean).join(' · ')}</Card.Description>
              </div>
              <Button size="sm" variant="ghost" onPress={() => void window.electronAPI.memory.deleteMemo(item.id).then(() => load())}>
                <TrashBin width={14} height={14} />
              </Button>
            </Card.Header>
            <Card.Content>
              <p className="whitespace-pre-wrap text-sm leading-7">{item.body || '（空）'}</p>
            </Card.Content>
          </Card>
        ))}

        <Card>
          <Card.Header>
            <Card.Title>聊天总结存档</Card.Title>
            <Card.Description>近一周/近一个月写完后会落在这里。点打开对话可以复查那一轮助手记录。</Card.Description>
          </Card.Header>
          <Card.Content className="space-y-2">
            {summaries.length === 0 && <p className="text-sm text-muted">还没有存档。在微信里让助手总结近一周后会出现。</p>}
            {summaries.map((item) => (
              <div key={item.fileName} className="flex items-center justify-between gap-3 rounded-lg px-3 py-2 hover:bg-muted/40">
                <div>
                  <div className="text-sm font-medium">{item.title}</div>
                  <div className="text-xs text-muted">{item.created || item.fileName}</div>
                </div>
                {item.conversationId ? (
                  <Button size="sm" variant="secondary" onPress={() => navigate('/agent?conversation=' + item.conversationId)}>打开对话</Button>
                ) : (
                  <Button size="sm" variant="tertiary" onPress={() => { void window.electronAPI.shell.openPath(item.path) }}>打开文件</Button>
                )}
              </div>
            ))}
          </Card.Content>
        </Card>
      </div>
    </div>
  )
}
