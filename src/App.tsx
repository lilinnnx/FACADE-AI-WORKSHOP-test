
import { useRef, useState } from 'react'
import './App.css'
import { generateFacade, type StageInfo } from './lib/facadeApi'

function stageLabel(info: StageInfo): string {
  if (info.stage === 'compress') return '正在压缩图片…'
  if (info.stage === 'create') return '正在创建生成任务…'
  return `正在生成…（第 ${info.attempt} 次查询）`
}

function App() {
  const [image, setImage] = useState<string | null>(null)
  const [file, setFile] = useState<File | null>(null)
  const [strength, setStrength] = useState(70)
  const [style, setStyle] = useState('新中式')
  const [material, setMaterial] = useState('清水混凝土')
  const [verticalGreenery, setVerticalGreenery] = useState(false)

  const [busy, setBusy] = useState(false)
  const [stage, setStage] = useState('')
  const [result, setResult] = useState('')
  const [error, setError] = useState('')

  const busyRef = useRef(false)
  const inputRef = useRef<HTMLInputElement>(null)

  const handleUpload = (event: React.ChangeEvent<HTMLInputElement>) => {
    const next = event.target.files?.[0]
    if (!next) return

    if (image) URL.revokeObjectURL(image)
    setFile(next)
    setImage(URL.createObjectURL(next))
    setResult('')
    setError('')
  }

  const handleRemove = () => {
    if (image) URL.revokeObjectURL(image)
    setFile(null)
    setImage(null)
    setResult('')
    setError('')
    if (inputRef.current) inputRef.current.value = ''
  }

  const handleGenerate = async () => {
    // 防连点：state 更新是异步的，用 ref 挡住连续点击
    if (busyRef.current || !file) return

    busyRef.current = true
    setBusy(true)
    setError('')
    setResult('')
    setStage('正在压缩图片…')

    try {
      const { imageUrl } = await generateFacade(
        { file, strength, style, material, greenery: verticalGreenery },
        { onStage: (info) => setStage(stageLabel(info)) },
      )
      setResult(imageUrl)
    } catch (err) {
      setError(err instanceof Error ? err.message : '生成失败，请重试')
    } finally {
      busyRef.current = false
      setBusy(false)
      setStage('')
    }
  }

  return (
    <div className="app">
      <header className="header">
        <div className="logo">F<span>A</span></div>
        <div>
          <h1>FACADE AI STUDIO</h1>
          <p>PARAMETRIC FACADE DESIGN WORKSHOP</p>
        </div>
        <div className="status">● SYSTEM READY</div>
      </header>

      <main className="workspace">
        <section className="intro">
          <p className="eyebrow">AI ARCHITECTURE DESIGN TOOL</p>
          <h2>重新想象建筑的<span>立面</span></h2>
          <p>上传建筑现状照片，探索 AI 驱动的立面设计可能性。</p>
        </section>

        <div className="main-grid">
          <section className="panel image-panel">
            <div className="panel-title">
              <span>01 / IMAGE INPUT</span>
              <span>图像输入</span>
            </div>

            <label className="upload-area">
              {image ? (
                <img src={image} alt="上传的建筑照片" />
              ) : (
                <div className="upload-placeholder">
                  <div className="upload-icon">＋</div>
                  <h3>上传建筑现状照片</h3>
                  <p>点击选择图片，支持 JPG、PNG、WEBP</p>
                  <span className="upload-button">选择本地图片</span>
                </div>
              )}
              <input
                ref={inputRef}
                type="file"
                accept="image/*"
                onChange={handleUpload}
                hidden
              />
            </label>

            {image && (
              <button className="remove-button" onClick={handleRemove}>
                移除图片
              </button>
            )}
          </section>

          <section className="panel control-panel">
            <div className="panel-title">
              <span>02 / DESIGN CONTROL</span>
              <span>设计控制</span>
            </div>

            <div className="control-group">
              <label>立面风格 <span>FACADE STYLE</span></label>
              <div className="select-wrap">
                <select
                  className="style-select"
                  value={style}
                  onChange={(event) => setStyle(event.target.value)}
                  aria-label="立面风格"
                >
                  {['新中式', '极简主义', '参数化未来风'].map((item) => (
                    <option key={item} value={item}>{item}</option>
                  ))}
                </select>
                <span className="select-chevron" aria-hidden="true">⌄</span>
              </div>
            </div>

            <div className="control-group">
              <label>立面材质 <span>FACADE MATERIAL</span></label>
              <div className="material-options" role="group" aria-label="立面材质">
                {['清水混凝土', '玻璃幕墙', '木格栅'].map((item) => (
                  <button
                    key={item}
                    type="button"
                    className={material === item ? 'material-button active' : 'material-button'}
                    aria-pressed={material === item}
                    onClick={() => setMaterial(item)}
                  >
                    {item}
                  </button>
                ))}
              </div>
            </div>

            <div className="control-group greenery-group">
              <label id="greenery-label">立体绿化 <span>VERTICAL GREENERY</span></label>
              <div className="greenery-control">
                <span className={!verticalGreenery ? 'greenery-choice selected' : 'greenery-choice'}>无</span>
                <button
                  type="button"
                  className={verticalGreenery ? 'greenery-toggle on' : 'greenery-toggle'}
                  role="switch"
                  aria-checked={verticalGreenery}
                  aria-labelledby="greenery-label"
                  onClick={() => setVerticalGreenery((enabled) => !enabled)}
                >
                  <span className="greenery-toggle-knob" />
                </button>
                <span className={verticalGreenery ? 'greenery-choice selected' : 'greenery-choice'}>垂直绿化</span>
              </div>
            </div>

            <div className="control-group">
              <label>原图保留程度 <span>IMAGE PRESERVATION</span></label>
              <div className="slider-value">{strength}<small>%</small></div>
              <input
                className="strength-slider"
                type="range"
                min="45"
                max="100"
                value={strength}
                onChange={(event) => setStrength(Number(event.target.value))}
              />
              <div className="slider-labels">
                <span>45% 起（自由生成）</span>
                <span>完全保留原图</span>
              </div>
              <p className="control-note">
                当前保留程度：{strength}%
              </p>
            </div>

            <button
              className="generate-button"
              disabled={!file || busy}
              onClick={handleGenerate}
            >
              {busy ? 'GENERATING…' : file ? 'GENERATE DESIGN ↗' : '请先上传建筑照片'}
            </button>

            {stage && <p className="control-note">{stage}</p>}
            {error && <p className="error-note">{error}</p>}

            {result && (
              <div className="result-preview">
                <img src={result} alt="生成结果" />
                <a href={result} target="_blank" rel="noreferrer">查看大图 ↗</a>
              </div>
            )}

            <p className="api-note">AI 生图接口已接入 · 每张约 0.05 元</p>
          </section>
        </div>
      </main>

      <footer>FACADE AI WORKSHOP © 2026 · ARCHITECTURE & TECHNOLOGY</footer>
    </div>
  )
}

export default App
