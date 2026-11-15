// 前端核心逻辑：滑块映射、查字典、压缩图片、创建任务、轮询结果

const API_BASE = import.meta.env.VITE_API_BASE || '/api/proxy'
const APP_TOKEN = import.meta.env.VITE_APP_TOKEN || ''

const STYLE_CODE: Record<string, string> = {
  新中式: 'S1',
  极简主义: 'S2',
  参数化未来风: 'S3',
}

const MATERIAL_CODE: Record<string, string> = {
  清水混凝土: 'M1',
  玻璃幕墙: 'M2',
  木格栅: 'M3',
}

export interface FacadeInput {
  file: File
  strength: number
  style: string
  material: string
  greenery: boolean
}

export type StageInfo =
  | { stage: 'compress' }
  | { stage: 'create' }
  | { stage: 'polling'; attempt: number; taskId: string }

export interface GenerateOptions {
  onStage?: (info: StageInfo) => void
  signal?: AbortSignal
}

export interface GenerateResult {
  imageUrl: string
  taskId: string
  key: string
}

interface PromptEntry {
  prompt: string
  negative_prompt?: string
}

type PromptDict = Record<string, PromptEntry>

interface CompressedImage {
  dataUrl: string
  width: number
  height: number
}

// 45-69 -> P2，70-89 -> P3，90-100 -> P4
export function strengthToLevel(strength: number): 'P2' | 'P3' | 'P4' {
  const value = Math.max(45, Math.min(100, Math.round(Number(strength) || 45)))
  if (value >= 90) return 'P4'
  if (value >= 70) return 'P3'
  return 'P2'
}

export function buildPromptKey(input: {
  strength: number
  style: string
  material: string
  greenery: boolean
}): string {
  const level = strengthToLevel(input.strength)
  const style = STYLE_CODE[input.style]
  const material = MATERIAL_CODE[input.material]

  if (!style) throw new Error(`未知的立面风格：${input.style}`)
  if (!material) throw new Error(`未知的立面材质：${input.material}`)

  return `${level}-${style}-${material}-${input.greenery ? 'G1' : 'G0'}`
}

let promptsPromise: Promise<PromptDict> | null = null

export function loadPrompts(): Promise<PromptDict> {
  if (!promptsPromise) {
    promptsPromise = fetch('/prompts.json', { cache: 'force-cache' })
      .then((response) => {
        if (!response.ok) throw new Error('提示词字典加载失败')
        return response.json() as Promise<PromptDict>
      })
      .catch((error: unknown) => {
        promptsPromise = null
        throw error
      })
  }
  return promptsPromise
}

function loadImage(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file)
    const img = new Image()
    img.onload = () => {
      URL.revokeObjectURL(url)
      resolve(img)
    }
    img.onerror = () => {
      URL.revokeObjectURL(url)
      reject(new Error('图片读取失败'))
    }
    img.src = url
  })
}

function drawToDataUrl(
  img: HTMLImageElement,
  maxSide: number,
  quality: number,
): CompressedImage {
  let width = img.naturalWidth || img.width
  let height = img.naturalHeight || img.height

  const scale = Math.min(1, maxSide / Math.max(width, height))
  width = Math.round(width * scale)
  height = Math.round(height * scale)

  // 万相要求参考图宽高都 >= 384
  const shortSide = Math.min(width, height)
  if (shortSide < 384) {
    const up = 384 / shortSide
    width = Math.round(width * up)
    height = Math.round(height * up)
  }

  if (Math.max(width, height) > 5000) {
    throw new Error('图片宽高比过于极端，请裁剪后再试')
  }

  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height

  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('浏览器不支持 Canvas')

  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, width, height)
  ctx.drawImage(img, 0, 0, width, height)

  return {
    dataUrl: canvas.toDataURL('image/jpeg', quality),
    width,
    height,
  }
}

/**
 * 压到长边 1280，JPEG 0.75；如果 base64 仍然太大，自动降级重压。
 * 之前 1600px 会把 POST 拖到 9 秒以上，所以降到 1280。
 */
export async function compressImage(file: File): Promise<CompressedImage> {
  const img = await loadImage(file)

  const attempts = [
    { maxSide: 1280, quality: 0.75 },
    { maxSide: 1152, quality: 0.7 },
    { maxSide: 1024, quality: 0.65 },
    { maxSide: 896, quality: 0.6 },
    { maxSide: 800, quality: 0.55 },
  ]

  // 约 1.05 MB 二进制；POST 在 Netlify 上才能在 2-3 秒内提交完
  const MAX_DATA_URL_CHARS = 1400000

  let last: CompressedImage | null = null
  for (const attempt of attempts) {
    last = drawToDataUrl(img, attempt.maxSide, attempt.quality)
    if (last.dataUrl.length <= MAX_DATA_URL_CHARS) return last
  }

  if (!last) throw new Error('图片压缩失败')
  throw new Error('图片压缩后仍然过大，请换一张尺寸更小的照片')
}

async function readJson(response: Response): Promise<any> {
  const text = await response.text()

  if (!text) {
    return {
      ok: false,
      error: {
        code: 'empty_response',
        message: `接口返回空响应（HTTP ${response.status}）`,
      },
    }
  }

  try {
    return JSON.parse(text)
  } catch {
    return {
      ok: false,
      error: {
        code: 'invalid_response',
        message: `接口返回非 JSON（HTTP ${response.status}）：${text.slice(0, 160)}`,
      },
    }
  }
}

function apiError(json: any, status: number): Error {
  const detail = json && json.error

  if (detail) {
    const parts: string[] = [detail.message || detail.code || '接口错误']
    if (detail.code && detail.message) parts.push(`(${detail.code})`)
    if (detail.stage) parts.push(`阶段：${detail.stage}`)
    if (detail.upstream_status) parts.push(`上游 HTTP ${detail.upstream_status}`)
    return new Error(parts.join(' · '))
  }

  return new Error(`接口请求失败（HTTP ${status}）`)
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms)
    if (signal) {
      signal.addEventListener(
        'abort',
        () => {
          clearTimeout(timer)
          reject(new DOMException('Aborted', 'AbortError'))
        },
        { once: true },
      )
    }
  })
}

function requestHeaders(): Record<string, string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (APP_TOKEN) headers['x-app-token'] = APP_TOKEN
  return headers
}

const POLL_INTERVAL_MS = 3000
const POLL_MAX_ATTEMPTS = 60 // 3 分钟

/**
 * 健康检查：浏览器直接访问 /api/proxy?health=1 也能看
 */
export async function checkProxyHealth(): Promise<any> {
  const response = await fetch(`${API_BASE}?health=1`)
  const json = await readJson(response)
  if (!response.ok || json.ok === false) throw apiError(json, response.status)
  return json
}

/**
 * 完整生成流程：查字典 → 压缩图片 → POST 创建任务 → GET 轮询
 */
export async function generateFacade(
  input: FacadeInput,
  options: GenerateOptions = {},
): Promise<GenerateResult> {
  const { onStage, signal } = options

  const prompts = await loadPrompts()
  const key = buildPromptKey(input)
  const entry = prompts[key]

  if (!entry || !entry.prompt) {
    throw new Error(`提示词缺失：${key}`)
  }

  onStage?.({ stage: 'compress' })
  const image = await compressImage(input.file)

  onStage?.({ stage: 'create' })

  const createController = new AbortController()
  const onAbort = () => createController.abort()
  if (signal) {
    if (signal.aborted) createController.abort()
    else signal.addEventListener('abort', onAbort, { once: true })
  }
  const createTimer = setTimeout(() => createController.abort(), 20000)

  let createResponse: Response
  try {
    createResponse = await fetch(API_BASE, {
      method: 'POST',
      headers: requestHeaders(),
      body: JSON.stringify({
        image_base64: image.dataUrl,
        prompt: entry.prompt,
        negative_prompt: entry.negative_prompt || '',
        width: image.width,
        height: image.height,
      }),
      signal: createController.signal,
    })
  } catch (error) {
    const isAbort = error instanceof DOMException && error.name === 'AbortError'
    throw new Error(
      isAbort ? '提交任务超时（20 秒），请重试' : '网络错误，提交任务失败',
    )
  } finally {
    clearTimeout(createTimer)
    if (signal) signal.removeEventListener('abort', onAbort)
  }

  const createJson = await readJson(createResponse)
  if (!createResponse.ok || createJson?.ok === false || createJson?.error) {
    throw apiError(createJson, createResponse.status)
  }

  const taskId: string | undefined = createJson.task_id
  if (!taskId) throw new Error('没有拿到 task_id')

  for (let attempt = 1; attempt <= POLL_MAX_ATTEMPTS; attempt++) {
    onStage?.({ stage: 'polling', attempt, taskId })
    await sleep(POLL_INTERVAL_MS, signal)

    const queryResponse = await fetch(
      `${API_BASE}?task_id=${encodeURIComponent(taskId)}`,
      { headers: requestHeaders(), signal },
    )

    const queryJson = await readJson(queryResponse)
    if (!queryResponse.ok || queryJson?.ok === false || queryJson?.error) {
      throw apiError(queryJson, queryResponse.status)
    }

    const status = String(queryJson.status || '').toUpperCase()

    if (status === 'SUCCEEDED' && queryJson.image_url) {
      return {
        imageUrl: queryJson.image_url as string,
        taskId,
        key,
      }
    }

    if (status === 'FAILED' || status === 'CANCELED' || status === 'UNKNOWN') {
      throw new Error(queryJson.message || `任务失败：${status}`)
    }
  }

  throw new Error('生成超时（3 分钟），请稍后重试')
}
