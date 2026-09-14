import { useCallback, useEffect, useState } from 'react'
import { Button, Card, InputGroup, TextField } from '@heroui/react'
import { Check, Plus, TrashBin } from '@gravity-ui/icons'

type TodoItem = {
  id: string
  title: string
  due: string
  done: boolean
  person?: string
  unverified?: boolean
}

type TodoWhen = 'today' | 'tomorrow'

export default function HuajiTodoBoard() {
  const [todayItems, setTodayItems] = useState<TodoItem[]>([])
  const [tomorrowItems, setTomorrowItems] = useState<TodoItem[]>([])
  const [todayDraft, setTodayDraft] = useState('')
  const [tomorrowDraft, setTomorrowDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    const [today, tomorrow] = await Promise.all([
      window.electronAPI.todo.list('today'),
      window.electronAPI.todo.list('tomorrow'),
    ])
    if (!today.success) throw new Error(today.error || '读取今日待办失败')
    if (!tomorrow.success) throw new Error(tomorrow.error || '读取明日待办失败')
    setTodayItems(today.items || [])
    setTomorrowItems(tomorrow.items || [])
  }, [])

  useEffect(() => {
    void load().catch((err) => setError(err instanceof Error ? err.message : String(err)))
  }, [load])

  const add = async (when: TodoWhen, title: string) => {
    const text = title.trim()
    if (!text || busy) return
    setBusy(true)
    setError('')
    try {
      const res = await window.electronAPI.todo.add({ title: text, when })
      if (!res.success) throw new Error(res.error || '添加失败')
      if (when === 'today') setTodayDraft('')
      else setTomorrowDraft('')
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : '添加失败')
    } finally {
      setBusy(false)
    }
  }

  const toggle = async (item: TodoItem) => {
    setBusy(true)
    setError('')
    try {
      const res = item.done
        ? await window.electronAPI.todo.uncomplete(item.id)
        : await window.electronAPI.todo.complete(item.id)
      if (!res.success) throw new Error(res.error || '更新失败')
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : '更新失败')
    } finally {
      setBusy(false)
    }
  }

  const remove = async (id: string) => {
    setBusy(true)
    setError('')
    try {
      const res = await window.electronAPI.todo.remove(id)
      if (!res.success) throw new Error(res.error || '删除失败')
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : '删除失败')
    } finally {
      setBusy(false)
    }
  }

  const column = (when: TodoWhen, title: string, items: TodoItem[], draft: string, setDraft: (value: string) => void) => (
    <Card className="min-w-0 flex-1">
      <Card.Header className="gap-2">
        <Card.Title className="text-base">{title}</Card.Title>
        <Card.Description className="text-sm">
          {when === 'today' ? '今天要办的事' : '明天要办的事'}
        </Card.Description>
      </Card.Header>
      <Card.Content className="space-y-3">
        {items.length === 0 ? (
          <p className="m-0 text-sm text-muted-foreground">还没有。下面记一条，或微信说「把我和张俊博今天的待办记下来」。</p>
        ) : (
          <ul className="m-0 list-none space-y-2 p-0">
            {items.map((item) => (
              <li key={item.id} className="flex items-start gap-2 rounded-lg bg-surface px-2 py-2">
                <button
                  aria-label={item.done ? '标为未完成' : '完成'}
                  className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded border border-border"
                  type="button"
                  onClick={() => void toggle(item)}
                >
                  {item.done ? <Check className="size-3.5" /> : null}
                </button>
                <span className={'min-w-0 flex-1 text-sm leading-6 ' + (item.done ? 'text-muted-foreground line-through' : 'text-foreground')}>
                  {item.unverified ? <span className="mr-1 text-xs text-muted-foreground">待核</span> : null}
                  {item.title}
                  {item.person ? <span className="ml-1 text-xs text-muted-foreground">（{item.person}）</span> : null}
                </span>
                <Button isIconOnly aria-label="删除待办" size="sm" variant="ghost" onPress={() => void remove(item.id)}>
                  <TrashBin className="size-4" />
                </Button>
              </li>
            ))}
          </ul>
        )}
        <TextField
          fullWidth
          value={draft}
          onChange={setDraft}
        >
          <InputGroup>
            <InputGroup.Input
              placeholder={when === 'today' ? '今天要办…' : '明天要办…'}
              onKeyDown={(event: { key: string; preventDefault: () => void }) => {
                if (event.key === 'Enter') {
                  event.preventDefault()
                  void add(when, draft)
                }
              }}
            />
            <Button isIconOnly aria-label="添加待办" size="sm" variant="secondary" onPress={() => void add(when, draft)}>
              <Plus className="size-4" />
            </Button>
          </InputGroup>
        </TextField>
      </Card.Content>
    </Card>
  )

  return (
    <div className="mx-7 mb-4 space-y-3">
      {error ? <p className="m-0 text-sm text-danger">{error}</p> : null}
      <div className="flex flex-col gap-3 lg:flex-row">
        {column('today', '今日待办', todayItems, todayDraft, setTodayDraft)}
        {column('tomorrow', '明日待办', tomorrowItems, tomorrowDraft, setTomorrowDraft)}
      </div>
    </div>
  )
}
