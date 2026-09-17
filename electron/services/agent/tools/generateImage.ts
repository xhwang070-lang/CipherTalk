/**
 * generate_image — AI image tool. Text-to-image, or edit a user-supplied image.
 */
import { tool } from 'ai'
import { z } from 'zod'
import fs from 'fs'
import { generateImageToFile, type ImageGenSourceImage } from '../../ai/imageGenService'
import { detectImageMime, resolveMediaIdToFile, stripFileProtocol } from '../../media/mediaResolver'
import type { AgentUploadedMediaContext } from '../types'

function decodeUploadedDataUrl(dataUrl: string): ImageGenSourceImage | null {
  const match = String(dataUrl || '').match(/^data:([^;]+);base64,(.+)$/i)
  if (!match) return null
  try {
    const data = Buffer.from(match[2], 'base64')
    if (!data.length) return null
    return { data, mediaType: match[1].trim() || 'image/png' }
  } catch {
    return null
  }
}

function looksLikeEditPrompt(prompt: string): boolean {
  return /这张图|图上|图里|把.{0,20}改|改成|改掉|修图|改图|替换|擦掉|去掉|改一下|保持.{0,8}不变/.test(String(prompt || ''))
}

async function resolveSourceImage(
  mediaId: string | undefined,
  prompt: string,
  uploadedMediaContext?: AgentUploadedMediaContext,
): Promise<{ sourceImage?: ImageGenSourceImage; error?: string; sourceLabel?: string }> {
  const uploaded = uploadedMediaContext?.images || []
  const requested = String(mediaId || '').trim()
  const useUpload = requested
    ? requested.toLowerCase().startsWith('upload-')
    : uploaded.length > 0 && looksLikeEditPrompt(prompt)

  if (useUpload) {
    const image = uploaded.find((item) => item.id === (requested || 'upload-1')) || uploaded[0]
    if (!image) {
      return { error: '当前没有可改的原图。请先发图片，再说要改哪里。' }
    }
    const decoded = decodeUploadedDataUrl(image.dataUrl)
    if (!decoded) return { error: '原图无法解码，请重新发图后再试。' }
    return { sourceImage: decoded, sourceLabel: image.id || 'upload-1' }
  }

  if (!requested) return {}

  const resolved = await resolveMediaIdToFile(requested)
  if (!resolved.success) return { error: resolved.error || '找不到这张历史图片' }
  const filePath = stripFileProtocol(resolved.filePath)
  if (!fs.existsSync(filePath)) return { error: '原图文件不存在或无法访问' }
  const buffer = fs.readFileSync(filePath)
  if (!buffer.length) return { error: '原图文件为空' }
  const mediaType = detectImageMime(buffer) || 'image/png'
  return { sourceImage: { data: buffer, mediaType }, sourceLabel: requested }
}

export function createGenerateImage(uploadedMediaContext?: AgentUploadedMediaContext) {
  return tool({
    description:
      '生成或修改图片。从零画图时只传 prompt；用户发了图并要求改字/改日期/修图/局部替换时必须带上原图。' +
      '本轮或上一轮用户发来的图用 mediaId=upload-1，不要凭文字重画一张看起来像的新图。' +
      'prompt 写具体画面或修改要求。从零画图必须按构图选择 size；改图不要传 size，保持原图比例。生成后会自动展示，不要输出路径或链接。',
    inputSchema: z.object({
      prompt: z.string().min(1).describe('画图描述，或改图指令，例如：把图中的 2025 全部改成 2026，其它布局和颜色保持不变'),
      mediaId: z
        .string()
        .optional()
        .describe('改图时必填。用户刚发的图用 upload-1；历史图用 search_media 返回的 mediaId。只画新图时不要传'),
      size: z
        .string()
        .optional()
        .describe(
          '图片尺寸，格式 宽x高。横图 1792x1024、竖图 1024x1792、方图 1024x1024。' +
            '用户未指定时必须自选。若报错不支持该尺寸，换用报错里的尺寸或省略 size 重试。',
        ),
    }),
    execute: async ({ prompt, mediaId, size }, { abortSignal }) => {
      const resolved = await resolveSourceImage(mediaId, prompt, uploadedMediaContext)
      if (resolved.error) return { error: resolved.error }
      const res = await generateImageToFile(prompt, {
        size: resolved.sourceImage ? undefined : size,
        signal: abortSignal,
        sourceImage: resolved.sourceImage,
      })
      if (!res.success) return { error: res.error || '图片生成失败' }
      if (!res.filePath || !fs.existsSync(res.filePath)) {
        return { error: '图片生成接口返回成功，但没有生成可读取的本地图片文件' }
      }
      const stat = fs.statSync(res.filePath)
      if (stat.size <= 0) {
        return { error: '图片生成接口返回成功，但生成的本地图片文件为空' }
      }
      return {
        success: true,
        filePath: res.filePath,
        mimeType: res.mimeType,
        edited: Boolean(resolved.sourceImage),
        source: resolved.sourceLabel,
        note: resolved.sourceImage
          ? '已按原图修改，并压回原图像素尺寸后自动展示，无需在回答中粘贴路径或链接'
          : '图片已生成并自动展示给用户，无需在回答中粘贴路径或链接',
      }
    },
  })
}

export const generateImage = createGenerateImage()