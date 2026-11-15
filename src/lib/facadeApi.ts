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
 * 压到长边 1600，JPEG 0.85；如果 base64 仍然太大，自动降级重压。
 */
export async function compressImage(file: File): Promise<CompressedImage> {
  const img = await loadImage(file)

  const attempts = [
    { maxSide: 1600, quality: 0.85 },
    { maxSide: 1400, quality: 0.8 },
    { maxSide: 1200, quality: 0.72 },
  ]

  let last: CompressedImage | null = null
  for (const attempt of attempts) {
    last = drawToDataUrl(img, attempt.maxSide, attempt.quality)
    if (last.dataUrl.length <= 4300000) return last
  }

  if (!last) throw new Error('图片压缩失败')
  return last
}

async function readJson(response: Response): Promise<any> {
  const text = await response.text()
  if (!text) return {}
  try {
    return JSON.parse(text)
  } catch {
    return { error: { message: text.slice(0, 200) } }
  }
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
  const createResponse = await fetch(API_BASE, {
    method: 'POST',
    headers: requestHeaders(),
    body: JSON.stringify({
      image_base64: image.dataUrl,
      prompt: entry.prompt,
      negative_prompt: entry.negative_prompt || '',
      width: image.width,
      height: image.height,
    }),
    signal,
  })

  const createJson = await readJson(createResponse)
  if (!createResponse.ok) {
    throw new Error(
      createJson?.error?.message || `创建任务失败（HTTP ${createResponse.status}）`,
    )
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
    if (!queryResponse.ok) {
      throw new Error(
        queryJson?.error?.message || `查询任务失败（HTTP ${queryResponse.status}）`,
      )
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
