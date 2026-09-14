import { tool } from 'ai'
import { z } from 'zod'
import {
  addHuajiTodo,
  completeHuajiTodo,
  listHuajiTodos,
  removeHuajiTodo,
  type HuajiTodoWhen,
} from '../huajiTodos'

export function createAddTodo() {
  return tool({
    description:
      '记下一条待办。用户说「记一下明天给张俊博发报价」「今天待办加上核对公差」时用。' +
      '只记用户明确要办的事，不要从别人的聊天里自动猜测待办。when=today 今天，tomorrow 明天。',
    inputSchema: z.object({
      title: z.string().min(1).describe('待办短句，例如 给张俊博发法兰报价'),
      when: z.enum(['today', 'tomorrow']).default('today').describe('today=今天，tomorrow=明天'),
      person: z.string().optional().describe('相关的人，没有就空'),
    }),
    execute: async ({ title, when, person }) => {
      try {
        const item = addHuajiTodo({ title, when: when as HuajiTodoWhen, person, source: 'user' })
        return { added: true, id: item.id, title: item.title, due: item.due }
      } catch (e) {
        return { error: e instanceof Error ? e.message : String(e) }
      }
    },
  })
}

export function createListTodos() {
  return tool({
    description:
      '查看华记待办清单。用户问「今天待办」「明天待办」「我还有什么事」时用。' +
      '这是用户自己的待办，不是微信好友日记，也不是华记工作日志。',
    inputSchema: z.object({
      when: z.enum(['today', 'tomorrow', 'all']).default('today'),
    }),
    execute: async ({ when }) => {
      const items = listHuajiTodos(when === 'all' ? 'all' : when)
      return {
        when,
        count: items.length,
        items: items.map((item) => ({
          id: item.id,
          title: item.title,
          due: item.due,
          done: item.done,
          person: item.person || '',
        })),
      }
    },
  })
}

export function createCompleteTodo() {
  return tool({
    description:
      '勾掉一条待办。用户说「张俊博报价已发」「完成待办 核对公差」时用。用标题关键词或 id。',
    inputSchema: z.object({
      query: z.string().min(1).describe('待办 id 或标题里的关键词'),
    }),
    execute: async ({ query }) => {
      const item = completeHuajiTodo(query)
      if (!item) return { completed: false, reason: '没有找到这条待办' }
      return { completed: true, id: item.id, title: item.title }
    },
  })
}

export function createRemoveTodo() {
  return tool({
    description: '删除一条待办。用户明确说删掉/不要了才用。',
    inputSchema: z.object({
      id: z.string().min(1).describe('待办 id，来自 list_todos'),
    }),
    execute: async ({ id }) => {
      const ok = removeHuajiTodo(id)
      return ok ? { removed: true, id } : { removed: false, reason: '没有这条待办' }
    },
  })
}
