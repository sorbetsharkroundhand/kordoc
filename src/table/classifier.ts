/**
 * IR 기반 semantic table / non-tabular layout 판별기 (issue #1)
 *
 * 공공문서에는 조직도·비상연락망·업무 체계도처럼 표 구조를 레이아웃 캔버스로
 * 사용한 도식이 있다. 저장 형식은 IRTable이지만 셀의 위치·간격·병합으로
 * 배치나 관계를 표현하는 구조(non-tabular-layout)를 진짜 데이터 표
 * (semantic-table)와 구별한다.
 *
 * 설계 원칙:
 * - 공통 IRTable 기반 — HWP/HWPX/PDF/DOCX 등 원본 포맷에 의존하지 않는다
 * - 순수 함수 — 입력을 변경하지 않고, 같은 입력에는 항상 같은 결과
 * - 단일 임계 조건이 아니라 semanticScore/nonTabularScore를 별도 가산하고,
 *   안정적인 reason code로 판정 근거를 설명한다
 * - 오탐보다 미탐을 허용하는 보수적 정책 — 두 점수가 모두 낮거나 차이가
 *   부족하면 uncertain. 문맥 키워드(조직도·연락망 등)만으로 비표를 확정하지 않는다
 * - O(rows × cols), 외부 의존성 없음
 *
 * 이 모듈은 기본 parse/markdown 출력에 배선되지 않는다(관측 전용).
 * semantic-table/uncertain은 향후 통합 시 기존 표 출력으로 폴백한다.
 */

import type { IRBlock, IRCell, IRTable } from "../types.js"

// ─── 공개 타입 ───────────────────────────────────────

/** 판별 결과 3단계 — 애매하면 uncertain (기존 표 처리 유지) */
export type TableClassificationKind =
  | "semantic-table"
  | "non-tabular-layout"
  | "uncertain"

/**
 * 판정 근거 코드 — 안정적인 문자열 계약. 소비자는 이 값으로 근거를 확인한다.
 */
export type TableClassificationReason =
  /** 활성 행의 열 위치·셀 수가 반복됨 */
  | "repeated-row-schema"
  /** 행마다 동일한 셀 경계가 반복됨 */
  | "grid-regularity"
  /** 활성 행/열 비율이 높음 */
  | "high-active-density"
  /** 숫자·날짜 등 열 단위 데이터 유형이 여러 행에서 반복됨 */
  | "column-type-consistency"
  /** 1×1 표가 셀 안의 중첩 표를 감싸는 레이아웃 래퍼 */
  | "nested-structure-wrapper"
  /** 병합 셀 크기·위치가 행마다 크게 달라짐 */
  | "span-irregularity"
  /** 내용 블록 사이 빈 행/열 밴드가 반복됨 */
  | "spacer-bands"
  /** 격자 대비 텍스트가 극도로 희소하고 행 스키마도 성립하지 않음 */
  | "extreme-sparsity"
  /** 인접 제목·캡션의 도식 문맥어 + 구조적 비표 신호 동반 */
  | "diagram-context-keyword"
  /** 양쪽 점수가 모두 낮아 판단 근거 부족 */
  | "low-evidence"
  /** 두 점수 차이가 충분하지 않음 */
  | "ambiguous-scores"

/**
 * 판별 입력 신호 — extractTableSignals가 측정한 원시 지표.
 * 밀도류는 보조 신호다. 빈 입력 양식도 진짜 표일 수 있다.
 */
export interface TableSignals {
  rows: number
  cols: number
  /** rows × cols (빈 격자 방어 하한 1) */
  gridArea: number
  /** 병합 커버가 아닌 실제 앵커 셀 수 */
  anchorCount: number
  /** 내용이 있는(텍스트 또는 이미지 블록) 앵커 수 */
  filledAnchorCount: number
  /** filledAnchorCount / gridArea */
  textDensity: number
  activeRowCount: number
  activeRowRatio: number
  activeColCount: number
  activeColRatio: number
  /** 행마다 동일한 셀 시작·끝 경계 반복 정도 (0-1, 최빈값 점유율) */
  gridRegularity: number
  /** 활성 행 시그니처(앵커 시작 열 나열)의 최대 그룹 점유율 (0-1) */
  rowSchemaConsistency: number
  /** 병합 셀 크기·위치의 행간 불규칙성 (0-1, 병합 없으면 0) */
  spanIrregularity: number
  mergedAnchorCount: number
  /** 병합 앵커가 덮는 격자 면적 비율 (0-1) */
  mergedCellRatio: number
  /** 내부(선두/말미 제외) 완전 빈 행 밴드 수 */
  spacerRowCount: number
  /** 내부 완전 빈 열 밴드 수 */
  spacerColCount: number
  /** 열 단위 데이터 유형(숫자·날짜 등) 일관성 (0-1) */
  columnDataTypeConsistency: number
  /** cell.blocks/captionBlocks 안의 중첩 표 개수 */
  nestedTableCount: number
  /** 1×1 표가 중첩 표를 감싸는 래퍼 후보 */
  isSingleCellWrapper: boolean
}

export interface TableClassification {
  kind: TableClassificationKind
  /** 두 점수의 차이를 반영 (0-1). 승리 점수 자체가 아니다 */
  confidence: number
  semanticScore: number
  nonTabularScore: number
  reasons: TableClassificationReason[]
  signals: TableSignals
  /**
   * cell.blocks/captionBlocks 안 중첩 표의 재귀 판별 결과 (문서 순서, DFS pre-order).
   * classifyTableBlocks 반환값에는 이 결과도 평탄되어 포함된다.
   */
  nested?: TableClassification[]
}

export interface TableClassificationContext {
  /** 표 바로 앞(상위) 문단/헤딩 텍스트 — 가까운 것부터 */
  precedingText?: string[]
  /** 표 바로 뒤(하위) 문단/헤딩 텍스트 — 가까운 것부터 */
  followingText?: string[]
}

// ─── 상수 ────────────────────────────────────────────

/** semantic 확정 하한 — 그 밑은 혼자 높아도 uncertain */
const SEMANTIC_MIN = 0.42
/** non-tabular 확정 하한 */
const NON_TABULAR_MIN = 0.38
/** 확정에 필요한 최소 점수 차 */
const DECISION_MARGIN = 0.14

/** 극도 희소 문턱 — 이 밀도 이하만 희소 신호 후보 */
const SPARSE_DENSITY_MAX = 0.15
/** 희소 신호가 의미 있으려면 최소한의 격자 크기 필요 */
const SPARSE_MIN_AREA = 24
/** 희소해도 "라벨+빈값" 양식처럼 스키마가 성립하면 비표 신호를 무력화 */
const SPARSE_NEUTRALIZE_FILLED = 8

/** spacer 밴드 점수 포화 — 빈 행 2개면 만점 */
const SPACER_ROW_SATURATION = 2
/** 빈 열 밴드는 3열 라벨 양식 오탐 방어를 위해 더 보수적으로 포화 */
const SPACER_COL_SATURATION = 3

/** 병합 불규칙 신호가 만점에 닿으려면 필요한 병합 앵커 수 하한 */
const MERGE_COVERAGE_FLOOR = 4

// ─── 내부 헬퍼 ───────────────────────────────────────

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x
}

function round3(x: number): number {
  return Math.round(x * 1000) / 1000
}

function cellHasContent(cell: IRCell | undefined): boolean {
  if (!cell) return false
  if (cell.text && cell.text.trim().length > 0) return true
  // 이미지 등 구조 콘텐츠만 있는 셀도 내용 있음으로 본다 (조직도 박스 대체)
  return !!cell.blocks?.some(b => (b.text && b.text.trim().length > 0) || b.type === "image" || (b.type === "table" && !!b.table))
}

/** 병합 커버를 걷어내고 앵커 셀만 수집 — tableToHtml과 같은 walk 규약 */
interface TableAnchor {
  row: number
  col: number
  colSpan: number
  rowSpan: number
  filled: boolean
}

function collectAnchors(table: IRTable): TableAnchor[] {
  const { rows, cols } = table
  const covered: boolean[][] = Array.from({ length: rows }, () => new Array<boolean>(cols).fill(false))
  const anchors: TableAnchor[] = []
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (covered[r][c]) continue
      const cell = table.cells[r]?.[c]
      const colSpan = Math.max(1, Math.min(cell?.colSpan ?? 1, cols - c))
      const rowSpan = Math.max(1, Math.min(cell?.rowSpan ?? 1, rows - r))
      anchors.push({ row: r, col: c, colSpan, rowSpan, filled: cellHasContent(cell) })
      for (let dr = 0; dr < rowSpan; dr++) {
        for (let dc = 0; dc < colSpan; dc++) covered[r + dr][c + dc] = true
      }
    }
  }
  return anchors
}

/** 최빈값 점유율 */
function modalShare<T>(values: T[]): number {
  if (values.length === 0) return 0
  const freq = new Map<T, number>()
  let bestCount = 0
  for (const v of values) {
    const n = (freq.get(v) ?? 0) + 1
    freq.set(v, n)
    if (n > bestCount) bestCount = n
  }
  return bestCount / values.length
}

const NUMERIC_RE = /^[+-]?₩?\d[\d,]*(\.\d+)?$/

/** 숫자·날짜·단위 부착 수치 → "data", 그 외 → "text" */
function classifyValueType(text: string): "data" | "text" {
  const t = text.trim()
  if (!t) return "text"
  if (/\d{4}[.\-/년]\s*\d{1,2}[.\-/월]\s*\d{1,2}/.test(t)) return "data"
  const stripped = t.replace(/(원|명|건|개|점|회|%|％|시간|분|초|km|m²|㎡|ha|억|만|천)\s*$/g, "")
  return NUMERIC_RE.test(stripped) ? "data" : "text"
}

/** 도식 문맥어 — 이 단어 하나만으로는 확정하지 않고 구조 신호와 결합한다 */
const DIAGRAM_CONTEXT_WORDS = [
  "비상연락망",
  "조직도",
  "조직체계도",
  "조직 체계도",
  "업무체계도",
  "업무 체계도",
  "연락망",
  "체계도",
  "기구표",
  "배치도",
]

/** 문맥 거리 감쇠 — index 0(바로 인접) 1.0, 이후 완화 */
const CONTEXT_DECAY = [1, 0.6, 0.35]

function contextKeywordStrength(texts: string[] | undefined): number {
  if (!texts?.length) return 0
  let strength = 0
  const limit = Math.min(texts.length, CONTEXT_DECAY.length)
  for (let i = 0; i < limit; i++) {
    const text = texts[i]
    if (!text) continue
    // 한글 문서의 균등배분("비 상 연 락 망")도 같은 문맥어로 취급한다.
    const normalizedText = text.replace(/\s+/g, "")
    if (DIAGRAM_CONTEXT_WORDS.some(w => normalizedText.includes(w.replace(/\s+/g, "")))) {
      strength = Math.max(strength, CONTEXT_DECAY[i])
    }
  }
  return strength
}

// ─── 신호 추출 ───────────────────────────────────────

/** 표 안의 중첩 표(IRTable)를 문서 순서대로 수집 — cell.blocks + captionBlocks */
function collectNestedTables(table: IRTable): IRTable[] {
  const found: IRTable[] = []
  const visitBlocks = (blocks: IRBlock[] | undefined) => {
    if (!blocks) return
    for (const b of blocks) {
      if (b.type === "table" && b.table) found.push(b.table)
    }
  }
  for (const row of table.cells) {
    for (const cell of row) visitBlocks(cell?.blocks)
  }
  visitBlocks(table.captionBlocks)
  return found
}

/**
 * IRTable에서 판별 신호를 측정한다. 순수 함수 — 입력을 변경하지 않는다.
 * O(rows × cols).
 */
export function extractTableSignals(table: IRTable): TableSignals {
  const rows = Math.max(0, table.rows)
  const cols = Math.max(0, table.cols)
  const gridArea = rows * cols

  const anchors = collectAnchors(table)
  const anchorCount = anchors.length
  const filledAnchors = anchors.filter(a => a.filled)
  const filledAnchorCount = filledAnchors.length
  const mergedAnchors = anchors.filter(a => a.colSpan > 1 || a.rowSpan > 1)

  // 행별 집계 — 셀 시작·끝 경계 규칙성과 활성 행 시그니처
  const rowCountPerRow: number[] = []
  const rowBoundaries: Array<Array<[start: number, end: number]>> =
    Array.from({ length: rows }, () => [])
  const activeSignatures: string[] = []
  const activeRowsSet = new Set<number>()
  const activeColsSet = new Set<number>()
  const rowStart = new Map<number, TableAnchor[]>()
  for (const a of anchors) {
    rowCountPerRow[a.row] = (rowCountPerRow[a.row] ?? 0) + 1
    for (let r = a.row; r < Math.min(rows, a.row + a.rowSpan); r++) {
      rowBoundaries[r].push([a.col, a.col + a.colSpan])
    }
    let list = rowStart.get(a.row)
    if (!list) {
      list = []
      rowStart.set(a.row, list)
    }
    list.push(a)
    if (a.filled) {
      activeRowsSet.add(a.row)
      activeColsSet.add(a.col)
    }
  }
  for (const r of [...activeRowsSet].sort((a, b) => a - b)) {
    const sig = (rowStart.get(r) ?? [])
      .map(a => a.col)
      .join(",")
    activeSignatures.push(`${sig}#${rowCountPerRow[r] ?? 0}`)
  }

  const activeRowCount = activeRowsSet.size
  const activeColCount = activeColsSet.size
  const rowBoundarySignatures = rowBoundaries.map(boundaries => boundaries
    .sort((a, b) => a[0] - b[0] || a[1] - b[1])
    .map(([start, end]) => `${start}:${end}`)
    .join(","))

  // 행 스키마 일관성 — 활성 행들의 시작 열 나열 최대 그룹 점유율
  let rowSchemaConsistency = 0
  if (activeSignatures.length > 0) {
    const freq = new Map<string, number>()
    let maxCount = 0
    for (const sig of activeSignatures) {
      const n = (freq.get(sig) ?? 0) + 1
      freq.set(sig, n)
      if (n > maxCount) maxCount = n
    }
    rowSchemaConsistency = maxCount / activeSignatures.length
  }

  // 병합 불규칙성 — 크기(shape) 다양성 + 시작 위치 다양성, 병합량 커버리지로 스케일
  let spanIrregularity = 0
  if (mergedAnchors.length >= 2) {
    const shapeShare = modalShare(mergedAnchors.map(a => a.colSpan * a.rowSpan))
    const colShare = modalShare(mergedAnchors.map(a => a.col))
    const coverage = clamp01(mergedAnchors.length / Math.max(MERGE_COVERAGE_FLOOR, anchorCount * 0.25))
    spanIrregularity = coverage * (0.6 * (1 - shapeShare) + 0.4 * (1 - colShare))
  }

  // spacer 밴드 — 선두/말미 가장자리는 제외 (양식 문서의 여백 행/열과 구별)
  let spacerRowCount = 0
  for (let r = 1; r < rows - 1; r++) {
    const rowAnchors = rowStart.get(r) ?? []
    if (rowAnchors.length > 0 && !rowAnchors.some(a => a.filled)) spacerRowCount++
  }
  const filledColsSet = new Set<number>()
  for (const a of filledAnchors) filledColsSet.add(a.col)
  let spacerColCount = 0
  for (let c = 1; c < cols - 1; c++) {
    if (!filledColsSet.has(c)) spacerColCount++
  }

  // 열 단위 데이터 유형 일관성 — 채워진 값 3개 이상인 열의 다수파 비율 가중 평균
  let columnDataTypeConsistency = 0
  {
    const colTypes = new Map<number, { data: number; total: number }>()
    for (const a of filledAnchors) {
      if (a.rowSpan > 1) continue // 세로 병합 라벨 — 유형 집계에서 제외
      const text = table.cells[a.row]?.[a.col]?.text ?? ""
      const entry = colTypes.get(a.col) ?? { data: 0, total: 0 }
      entry.total++
      if (classifyValueType(text) === "data") entry.data++
      colTypes.set(a.col, entry)
    }
    let weightSum = 0
    let weighted = 0
    for (const entry of colTypes.values()) {
      if (entry.total < 3) continue
      weightSum += entry.total
      weighted += (entry.data / entry.total) * entry.total
    }
    if (weightSum > 0) columnDataTypeConsistency = weighted / weightSum
  }

  const nestedTables = collectNestedTables(table)
  const isSingleCellWrapper = rows === 1 && cols === 1 && nestedTables.length > 0

  return {
    rows,
    cols,
    gridArea: Math.max(1, gridArea),
    anchorCount,
    filledAnchorCount,
    textDensity: round3(filledAnchorCount / Math.max(1, gridArea)),
    activeRowCount,
    activeRowRatio: round3(rows > 0 ? activeRowCount / rows : 0),
    activeColCount,
    activeColRatio: round3(cols > 0 ? activeColCount / cols : 0),
    gridRegularity: round3(modalShare(rowBoundarySignatures)),
    rowSchemaConsistency: round3(rowSchemaConsistency),
    spanIrregularity: round3(spanIrregularity),
    mergedAnchorCount: mergedAnchors.length,
    mergedCellRatio: round3(
      mergedAnchors.reduce((sum, a) => sum + a.colSpan * a.rowSpan, 0) / Math.max(1, gridArea),
    ),
    spacerRowCount,
    spacerColCount,
    columnDataTypeConsistency: round3(columnDataTypeConsistency),
    nestedTableCount: nestedTables.length,
    isSingleCellWrapper,
  }
}

// ─── 점수 계산 ───────────────────────────────────────

// 가중치: semantic = schema×3 + regularity×1 + activeCol×0.5 + colType×0.5 (총 5)
//         nonTabular = spanIrr×3 + spacer×2 + sparse×2 + context×1 (총 8)
const SEMANTIC_WEIGHT_TOTAL = 5
const NON_TABULAR_WEIGHT_TOTAL = 8

interface ScoreComponents {
  semantic: { schema: number; regularity: number; activeDensity: number; columnType: number }
  nonTabular: { spanIrr: number; spacer: number; sparse: number; context: number }
}

function scoreComponents(signals: TableSignals, context?: TableClassificationContext): ScoreComponents {
  // 1×1은 행·열 관계가 없어 스키마 근거로 쓸 수 없다. 그보다 큰 빈 입력
  // 양식은 활성 행이 하나여도 전체 격자 규칙성과 함께 약한 근거로 보존한다.
  const schemaReliability = signals.rows === 1 && signals.cols === 1
    ? 0
    : clamp01(signals.activeRowCount / 4)

  // 단일 열 표에서 활성 열 비율은 자명히 1이라 정보가 없다 — 행 비율만 본다
  const activeDensity = signals.cols > 1
    ? Math.max(signals.activeRowRatio, signals.activeColRatio * 0.7)
    : signals.activeRowRatio

  // 희소 무력화 — "라벨+빈값" 양식: 채워진 셀이 충분히 많고 스키마가 뚜렷이
  // 성립하면 낮은 밀도를 비표 근거로 쓰지 않는다. 문턱을 0.75로 둔 것은 반쯤
  // 반복되는 시그니처(schema≈0.5)를 가진 도식까지 무력화하지 않기 위함이다
  const isSparseCandidate =
    signals.textDensity <= SPARSE_DENSITY_MAX && signals.gridArea >= SPARSE_MIN_AREA
  const sparseNeutralized =
    signals.filledAnchorCount >= SPARSE_NEUTRALIZE_FILLED &&
    signals.rowSchemaConsistency >= 0.75
  const sparseFires = isSparseCandidate && !sparseNeutralized

  // 문맥 게이트 — 구조적 비표 신호(raw 합)가 어느 정도 있을 때만 문맥어가 가세한다.
  // 문서 제목의 "조직" 같은 단어 하나가 뒤의 진짜 표를 비표로 만들지 않는다.
  const structuralRaw =
    signals.spanIrregularity * 3 +
    clamp01(Math.max(
      Math.min(1, signals.spacerRowCount / SPACER_ROW_SATURATION),
      Math.min(1, signals.spacerColCount / SPACER_COL_SATURATION),
    )) * 2 +
    (sparseFires ? 2 : 0)
  const keywordStrength = Math.max(
    contextKeywordStrength(context?.precedingText),
    contextKeywordStrength(context?.followingText),
  )
  const contextComp = keywordStrength * clamp01(structuralRaw / 3)

  return {
    semantic: {
      schema: signals.rowSchemaConsistency * schemaReliability,
      regularity: signals.gridRegularity,
      activeDensity,
      columnType: signals.columnDataTypeConsistency,
    },
    nonTabular: {
      spanIrr: signals.spanIrregularity,
      spacer: clamp01(Math.max(
        Math.min(1, signals.spacerRowCount / SPACER_ROW_SATURATION),
        Math.min(1, signals.spacerColCount / SPACER_COL_SATURATION),
      )),
      sparse: sparseFires ? 1 : 0,
      context: contextComp,
    },
  }
}

function semanticScoreOf(c: ScoreComponents["semantic"]): number {
  return (
    (c.schema * 3 + c.regularity * 1 + c.activeDensity * 0.5 + c.columnType * 0.5) /
    SEMANTIC_WEIGHT_TOTAL
  )
}

function nonTabularScoreOf(c: ScoreComponents["nonTabular"]): number {
  return (
    (c.spanIrr * 3 + c.spacer * 2 + c.sparse * 2 + c.context * 1) /
    NON_TABULAR_WEIGHT_TOTAL
  )
}

function confidenceFor(win: number, lose: number): number {
  const diffPart = clamp01((win - lose) / 0.5) * 0.5
  const winPart = clamp01(win / 0.8) * 0.5
  return round3(diffPart + winPart)
}

// ─── 재귀 판별 ───────────────────────────────────────

const MAX_NESTED_DEPTH = 8

function collectNestedBlocks(blocks: IRBlock[] | undefined, out: IRBlock[]) {
  if (!blocks) return
  for (const b of blocks) {
    if (b.type === "table" && b.table) out.push(b)
  }
}

function classifyNested(table: IRTable, depth: number): TableClassification[] {
  if (depth >= MAX_NESTED_DEPTH) return []
  const nestedBlocks: IRBlock[] = []
  for (const row of table.cells) {
    for (const cell of row) collectNestedBlocks(cell?.blocks, nestedBlocks)
  }
  collectNestedBlocks(table.captionBlocks, nestedBlocks)
  const out: TableClassification[] = []
  for (const b of nestedBlocks) {
    const cls = classifyTableInner(b.table!, depth + 1)
    out.push(cls, ...cls.nested ?? [])
  }
  return out
}

// ─── 공개 API ────────────────────────────────────────

function classifyTableInner(
  table: IRTable,
  depth: number,
  context?: TableClassificationContext,
): TableClassification {
  const signals = extractTableSignals(table)
  const comp = scoreComponents(signals, context)
  const semanticScore = round3(semanticScoreOf(comp.semantic))
  const nonTabularScore = round3(nonTabularScoreOf(comp.nonTabular))
  const nested = classifyNested(table, depth)

  // 1×1 래퍼 — 셀 안에 중첩 표를 감싸면 그 자체가 레이아웃 컨테이너다.
  // 1×1에는 행/열 교차가 성립하지 않으므로 점수와 무관하게 구조 사실로 판정한다.
  if (signals.isSingleCellWrapper) {
    return {
      kind: "non-tabular-layout",
      confidence: 0.92,
      semanticScore,
      nonTabularScore: Math.max(nonTabularScore, 0.9),
      reasons: ["nested-structure-wrapper"],
      signals,
      nested,
    }
  }

  let kind: TableClassificationKind
  let confidence: number
  let reasons: TableClassificationReason[]

  if (nonTabularScore >= NON_TABULAR_MIN && nonTabularScore - semanticScore >= DECISION_MARGIN) {
    kind = "non-tabular-layout"
    confidence = confidenceFor(nonTabularScore, semanticScore)
    reasons = []
    if (comp.nonTabular.spanIrr > 0) reasons.push("span-irregularity")
    if (comp.nonTabular.spacer > 0) reasons.push("spacer-bands")
    if (comp.nonTabular.sparse > 0) reasons.push("extreme-sparsity")
    if (comp.nonTabular.context > 0) reasons.push("diagram-context-keyword")
    if (reasons.length === 0) reasons.push("ambiguous-scores")
  } else if (semanticScore >= SEMANTIC_MIN && semanticScore - nonTabularScore >= DECISION_MARGIN) {
    kind = "semantic-table"
    confidence = confidenceFor(semanticScore, nonTabularScore)
    reasons = []
    if (comp.semantic.schema >= 0.4) reasons.push("repeated-row-schema")
    if (comp.semantic.regularity >= 0.75) reasons.push("grid-regularity")
    if (signals.textDensity >= 0.6 || comp.semantic.activeDensity >= 0.75) reasons.push("high-active-density")
    if (comp.semantic.columnType >= 0.5) reasons.push("column-type-consistency")
    if (reasons.length === 0) reasons.push("grid-regularity")
  } else {
    kind = "uncertain"
    const diff = Math.abs(semanticScore - nonTabularScore)
    const bothLow = Math.max(semanticScore, nonTabularScore) < Math.min(SEMANTIC_MIN, NON_TABULAR_MIN)
    confidence = bothLow ? 0 : round3(clamp01(diff / DECISION_MARGIN) * 0.5)
    reasons = bothLow ? ["low-evidence"] : ["ambiguous-scores"]
  }

  return { kind, confidence, semanticScore, nonTabularScore, reasons, signals, nested }
}

/**
 * IRTable 하나를 3단계(semantic-table / non-tabular-layout / uncertain)로 판별한다.
 * 순수 함수 — 입력을 변경하지 않으며, cell.blocks·captionBlocks 안 중첩 표까지
 * 재귀 판별해 `nested`에 붙인다.
 */
export function classifyTable(
  table: IRTable,
  context?: TableClassificationContext,
): TableClassification {
  return classifyTableInner(table, 0, context)
}

/** 표 블록 주변 문맥 수집 — 다른 표를 만나면 전달을 끊는다 (제목 오염 차단) */
function gatherContext(blocks: IRBlock[], index: number): TableClassificationContext {
  const gather = (dir: 1 | -1): string[] => {
    const texts: string[] = []
    for (let i = index + dir; i >= 0 && i < blocks.length && texts.length < CONTEXT_DECAY.length; i += dir) {
      const b = blocks[i]
      if (b.type === "table") break // 다른 표 — 문맥 전달 차단
      if ((b.type === "paragraph" || b.type === "heading" || b.type === "list") && b.text?.trim()) {
        texts.push(b.text.trim())
      }
    }
    return texts
  }
  const captionText = (() => {
    const t = blocks[index].table
    const parts: string[] = []
    if (t?.caption) parts.push(t.caption)
    if (t?.captionBlocks) {
      for (const b of t.captionBlocks) {
        if (b.text?.trim()) parts.push(b.text.trim())
      }
    }
    return parts.join(" ")
  })()
  const preceding = gather(-1)
  if (captionText) preceding.unshift(captionText) // 캡션은 가장 가까운 문맥
  return { precedingText: preceding, followingText: gather(1) }
}

/**
 * 블록 배열에서 모든 표(중첩 포함, DFS pre-order)를 판별한다.
 *
 * 최상위 table 블록에는 인접 문맥(앞/뒤 최대 3개 텍스트 블록, 다른 표에서 차단)을
 * 자동 수집해 전달한다. 반환 배열에는 중첩 판별 결과도 문서 순서로 평탄되어
 * 포함된다 — 길이는 최상위 표 개수와 다를 수 있다.
 */
export function classifyTableBlocks(blocks: IRBlock[]): TableClassification[] {
  const out: TableClassification[] = []
  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i]
    if (block.type !== "table" || !block.table) continue
    const cls = classifyTable(block.table, gatherContext(blocks, i))
    out.push(cls, ...cls.nested ?? [])
  }
  return out
}
