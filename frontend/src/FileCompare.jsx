import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import './FileCompare.css'

function FilePicker({ label, file, onPick }) {
  const inputRef = useRef(null)
  const [dragOver, setDragOver] = useState(false)

  const handleDrop = (e) => {
    e.preventDefault()
    e.stopPropagation()
    setDragOver(false)
    if (e.dataTransfer.files?.[0]) onPick(e.dataTransfer.files[0])
  }

  return (
    <div
      className={`fc-drop${dragOver ? ' fc-drop--over' : ''}`}
      onClick={() => inputRef.current?.click()}
      onDragOver={(e) => {
        e.preventDefault()
        setDragOver(true)
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={handleDrop}
    >
      <input
        ref={inputRef}
        type="file"
        style={{ display: 'none' }}
        onChange={(e) => e.target.files?.[0] && onPick(e.target.files[0])}
      />
      <div className="fc-drop-label">{label}</div>
      <div className="fc-drop-name">{file ? file.name : '点击或拖拽文件到此处'}</div>
    </div>
  )
}

// Render a cell's text: plain string, or inline character-level segments where
// the differing parts are wrapped in a highlighted <mark>. A `caret` segment
// marks the position where the other side has inserted/deleted text.
function renderCell(plain, seg, side) {
  if (!seg) return plain ?? ''
  return seg.map((s, i) => {
    if (s.caret) {
      return <span key={i} className={`fc-caret fc-caret--${side}`} aria-hidden="true" />
    }
    return s.changed ? (
      <mark key={i} className={`fc-ch fc-ch--${side}`}>{s.text}</mark>
    ) : (
      <span key={i}>{s.text}</span>
    )
  })
}

function FileCompare({ token, onAuthError }) {
  const [file1, setFile1] = useState(null)
  const [file2, setFile2] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [result, setResult] = useState(null)
  const [onlyDiff, setOnlyDiff] = useState(false)
  const [normalizeJson, setNormalizeJson] = useState(false)
  const [ignoreWs, setIgnoreWs] = useState(false)
  const [ignoreCase, setIgnoreCase] = useState(false)
  const [activeBlock, setActiveBlock] = useState(0)
  const [expanded, setExpanded] = useState(() => new Set())

  const bodyRef = useRef(null)
  const anchorRefs = useRef([])
  const minimapRef = useRef(null)
  const viewportRef = useRef(null)

  const authHeaders = () => (token ? { Authorization: `Bearer ${token}` } : {})

  // `opts` overrides the current option state without waiting for a re-render;
  // with `autoDetect` on, a first plain pass that turns out to be JSON re-runs
  // once with formatting enabled.
  const handleCompare = async (opts = {}, autoDetect = true) => {
    if (!file1 || !file2) return
    const o = { normalize: normalizeJson, ignoreWs, ignoreCase, ...opts }
    setLoading(true)
    setError('')
    try {
      const form = new FormData()
      form.append('file1', file1)
      form.append('file2', file2)
      form.append('normalize_json', o.normalize ? 'true' : 'false')
      form.append('ignore_whitespace', o.ignoreWs ? 'true' : 'false')
      form.append('ignore_case', o.ignoreCase ? 'true' : 'false')
      const res = await fetch('/api/compare/files', {
        method: 'POST',
        headers: authHeaders(),
        body: form,
      })
      if (res.status === 401) {
        onAuthError?.()
        return
      }
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        throw new Error(err.detail || `服务器错误 ${res.status}`)
      }
      const data = await res.json()
      setResult(data)
      setActiveBlock(0)
      if (autoDetect && data.json_detected && !o.normalize) {
        setNormalizeJson(true)
        await handleCompare({ normalize: true }, false)
      }
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }

  const toggleNormalize = (checked) => {
    setNormalizeJson(checked)
    if (file1 && file2) handleCompare({ normalize: checked }, false)
  }

  const toggleIgnoreWs = (checked) => {
    setIgnoreWs(checked)
    if (file1 && file2) handleCompare({ ignoreWs: checked }, false)
  }

  const toggleIgnoreCase = (checked) => {
    setIgnoreCase(checked)
    if (file1 && file2) handleCompare({ ignoreCase: checked }, false)
  }

  const toggleExpand = (runId) => {
    setExpanded((prev) => {
      const next = new Set(prev)
      next.add(runId)
      return next
    })
  }

  // Lines of unchanged context to keep around each diff (0 in "only diff" mode).
  const CONTEXT = 3

  // Build the display list: rows, collapsed "gap" markers for long unchanged
  // runs (BC-style folding, expandable), the diff-block count for nav, and the
  // block positions used to render the minimap overview.
  const { items, blockCount, blocks } = useMemo(() => {
    const rows = result?.rows ?? []
    const context = onlyDiff ? 0 : CONTEXT

    const runs = []
    for (let i = 0; i < rows.length; i += 1) {
      const isEqual = rows[i].type === 'equal'
      const last = runs[runs.length - 1]
      if (last && last.equal === isEqual) last.end = i + 1
      else runs.push({ equal: isEqual, start: i, end: i + 1 })
    }

    const out = []
    const blockList = []
    let blockNoCount = 0
    runs.forEach((run, ri) => {
      if (!run.equal) {
        let repType = rows[run.start].type
        for (let i = run.start; i < run.end; i += 1) {
          if (rows[i].type === 'replace') {
            repType = 'replace'
            break
          }
        }
        blockList.push({ type: repType })
        for (let i = run.start; i < run.end; i += 1) {
          out.push({ kind: 'row', row: rows[i], blockNo: i === run.start ? blockNoCount : -1 })
        }
        blockNoCount += 1
        return
      }
      const length = run.end - run.start
      const topKeep = ri === 0 ? 0 : context
      const botKeep = ri === runs.length - 1 ? 0 : context
      const hidden = length - topKeep - botKeep
      if (expanded.has(run.start) || hidden < 2) {
        for (let i = run.start; i < run.end; i += 1) out.push({ kind: 'row', row: rows[i], blockNo: -1 })
        return
      }
      for (let i = run.start; i < run.start + topKeep; i += 1) out.push({ kind: 'row', row: rows[i], blockNo: -1 })
      out.push({ kind: 'gap', count: hidden, runId: run.start })
      for (let i = run.end - botKeep; i < run.end; i += 1) out.push({ kind: 'row', row: rows[i], blockNo: -1 })
    })
    return { items: out, blockCount: blockNoCount, blocks: blockList }
  }, [result, onlyDiff, expanded])

  useEffect(() => {
    setActiveBlock(0)
    setExpanded(new Set())
    anchorRefs.current = []
  }, [onlyDiff, result])

  // Minimap geometry measured from real layout so the diff ticks and the
  // viewport window track the true scroll position through collapsed gaps and
  // wrapped long lines. Both use the same scrollTop/scrollHeight mapping, so
  // they stay aligned (the native scrollbar is hidden — see CSS).
  const [tickRatios, setTickRatios] = useState([])

  // Move the viewport window directly via the ref to avoid re-rendering the
  // whole row list on every scroll frame.
  const updateViewport = () => {
    const body = bodyRef.current
    const vp = viewportRef.current
    if (!body || !vp) return
    const h = body.scrollHeight || 1
    vp.style.top = `${(body.scrollTop / h) * 100}%`
    vp.style.height = `${(body.clientHeight / h) * 100}%`
  }

  useLayoutEffect(() => {
    const sync = () => {
      const body = bodyRef.current
      if (!body) return
      const h = body.scrollHeight || 1
      setTickRatios(blocks.map((_, i) => {
        const el = anchorRefs.current[i]
        return el ? el.offsetTop / h : 0
      }))
      updateViewport()
    }
    sync()
    window.addEventListener('resize', sync)
    return () => window.removeEventListener('resize', sync)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, blocks])

  // Click/drag anywhere on the minimap to scrub; grabbing the viewport window
  // keeps the grabbed point under the cursor.
  const handleMinimapPointerDown = (e) => {
    if (e.target.closest('.fc-mm-tick')) return
    const body = bodyRef.current
    const mm = minimapRef.current
    if (!body || !mm) return
    e.preventDefault()
    const rect = mm.getBoundingClientRect()
    const h = body.scrollHeight || 1
    const vpTopPx = (body.scrollTop / h) * rect.height
    const vpHeightPx = (body.clientHeight / h) * rect.height
    const onWindow = !!e.target.closest('.fc-mm-viewport')
    const grabOffset = onWindow ? e.clientY - rect.top - vpTopPx : vpHeightPx / 2
    const scrub = (clientY) => {
      const topPx = clientY - rect.top - grabOffset
      body.scrollTop = (topPx / rect.height) * h
    }
    scrub(e.clientY)
    const move = (ev) => scrub(ev.clientY)
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  const goToBlock = (n) => {
    if (blockCount === 0) return
    const idx = ((n % blockCount) + blockCount) % blockCount
    setActiveBlock(idx)
    const el = anchorRefs.current[idx]
    const body = bodyRef.current
    if (el && body) {
      body.scrollTop = el.offsetTop - body.clientHeight / 2 + el.clientHeight / 2
    }
  }

  return (
    <div className="fc-container">
      <h2 className="fc-title">🔍 文件对比</h2>
      <p className="fc-subtitle">
        上传两个纯文本文件，并排查看逐行差异（新增 / 删除 / 修改）。
      </p>

      <div className="fc-pickers">
        <FilePicker label="文件 1（原始）" file={file1} onPick={setFile1} />
        <FilePicker label="文件 2（对比）" file={file2} onPick={setFile2} />
      </div>

      <div className="fc-actions">
        <button
          className="fc-btn"
          onClick={() => handleCompare()}
          disabled={!file1 || !file2 || loading}
        >
          {loading ? '对比中…' : '开始对比'}
        </button>
      </div>

      {error && <div className="fc-error">{error}</div>}

      {result && (
        <div className="fc-result">
          <div className="fc-summary">
            {result.identical ? (
              <span className="fc-badge fc-badge--equal">两个文件内容完全相同</span>
            ) : (
              <>
                <span className="fc-badge fc-badge--add">+{result.summary.added} 新增</span>
                <span className="fc-badge fc-badge--del">-{result.summary.removed} 删除</span>
                <span className="fc-badge fc-badge--chg">~{result.summary.changed} 修改</span>
              </>
            )}
            {result.truncated && (
              <span className="fc-badge fc-badge--warn">结果过长，已截断显示</span>
            )}
            {result.normalized && (
              <span className="fc-badge fc-badge--json">已格式化 JSON</span>
            )}
            {result.json_detected && !result.normalized && (
              <span className="fc-badge fc-badge--warn">检测到 JSON（未格式化）</span>
            )}
          </div>

          {!result.identical && (
            <div className="fc-toolbar">
              <div className="fc-toolbar-left">
                <label className="fc-toggle">
                  <input
                    type="checkbox"
                    checked={onlyDiff}
                    onChange={(e) => setOnlyDiff(e.target.checked)}
                  />
                  只看差异
                </label>
                <label className="fc-toggle">
                  <input
                    type="checkbox"
                    checked={ignoreWs}
                    onChange={(e) => toggleIgnoreWs(e.target.checked)}
                  />
                  忽略空白
                </label>
                <label className="fc-toggle">
                  <input
                    type="checkbox"
                    checked={ignoreCase}
                    onChange={(e) => toggleIgnoreCase(e.target.checked)}
                  />
                  忽略大小写
                </label>
                {result.json_detected && (
                  <label className="fc-toggle">
                    <input
                      type="checkbox"
                      checked={normalizeJson}
                      onChange={(e) => toggleNormalize(e.target.checked)}
                    />
                    格式化 JSON 后比较
                  </label>
                )}
              </div>
              <div className="fc-nav">
                <button
                  className="fc-nav-btn"
                  onClick={() => goToBlock(activeBlock - 1)}
                  disabled={blockCount === 0}
                >
                  ↑ 上一处
                </button>
                <span className="fc-nav-count">
                  {blockCount === 0 ? '0 / 0' : `${activeBlock + 1} / ${blockCount}`}
                </span>
                <button
                  className="fc-nav-btn"
                  onClick={() => goToBlock(activeBlock + 1)}
                  disabled={blockCount === 0}
                >
                  下一处 ↓
                </button>
              </div>
            </div>
          )}

          <div className="fc-diff">
            <div className="fc-diff-body" ref={bodyRef} onScroll={updateViewport}>
              <div className="fc-diff-head">
                <div className="fc-col-head">{result.file1}</div>
                <div className="fc-col-head">{result.file2}</div>
              </div>
              {items.map((item, i) => {
                if (item.kind === 'gap') {
                  return (
                    <button
                      key={`gap-${i}`}
                      type="button"
                      className="fc-gap"
                      onClick={() => toggleExpand(item.runId)}
                    >
                      ⋯ 展开 {item.count} 行相同内容 ⋯
                    </button>
                  )
                }
                const { row, blockNo } = item
                const isActive = blockNo >= 0 && blockNo === activeBlock
                return (
                  <div
                    key={`row-${i}`}
                    ref={blockNo >= 0 ? (el) => { anchorRefs.current[blockNo] = el } : undefined}
                    className={`fc-row fc-row--${row.type}${isActive ? ' fc-row--active' : ''}`}
                  >
                    <div className="fc-cell fc-cell--left">
                      <span className="fc-ln">{row.left_no ?? ''}</span>
                      <pre className="fc-text">{renderCell(row.left, row.left_seg, 'left')}</pre>
                    </div>
                    <div className="fc-cell fc-cell--right">
                      <span className="fc-ln">{row.right_no ?? ''}</span>
                      <pre className="fc-text">{renderCell(row.right, row.right_seg, 'right')}</pre>
                    </div>
                  </div>
                )
              })}
            </div>
            {blocks.length > 0 && (
              <div
                className="fc-minimap"
                ref={minimapRef}
                onPointerDown={handleMinimapPointerDown}
                aria-hidden="true"
              >
                <div className="fc-mm-viewport" ref={viewportRef} />
                {blocks.map((b, i) => (
                  <button
                    key={`mm-${i}`}
                    type="button"
                    className={`fc-mm-tick fc-mm-tick--${b.type}${i === activeBlock ? ' fc-mm-tick--active' : ''}`}
                    style={{ top: `${(tickRatios[i] ?? 0) * 100}%` }}
                    onClick={() => goToBlock(i)}
                    title={`第 ${i + 1} 处差异`}
                  />
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

export default FileCompare
