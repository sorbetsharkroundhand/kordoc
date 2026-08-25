/**
 * 표 판별기(classifier) 테스트 — semantic-table / non-tabular-layout / uncertain
 *
 * 원본 HWP/HWPX 조직도 샘플은 개인정보·저장소 정책상 커밋하지 않고,
 * 실제 문서의 구조(격자 크기·병합 배치·텍스트 희소성)를 최소화·익명화한
 * 프로그램 방식 IRTable fixture로만 검증한다 (issue #1 테스트 데이터 정책).
 */

import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "fs"
import { resolve, dirname } from "path"
import { fileURLToPath } from "url"
import { buildTable } from "../src/table/builder.js"
import { extractTableSignals, classifyTable, classifyTableBlocks } from "../src/table/classifier.js"
import { parse } from "../src/index.js"
import type { CellContext, IRBlock, IRTable } from "../src/types.js"

const FIXTURES_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "fixtures")

// ─── fixture 헬퍼 ─────────────────────────────────────

/** 문자열 격자 → 1×1 CellContext */
function plain(rowsText: string[][]): CellContext[][] {
  return rowsText.map(row =>
    row.map(text => ({ text, colSpan: 1, rowSpan: 1 })),
  )
}

/**
 * 절대 좌표 박스 배치 — 조직도 도식 재현용.
 * [rowAddr, colAddr, rowSpan, colSpan, text] 목록을 격자에 흩어놓는다.
 */
type Box = [row: number, col: number, rowSpan: number, colSpan: number, text?: string]

function scatterBoxes(rows: number, cols: number, boxes: Box[]): IRTable {
  const cells: CellContext[][] = Array.from({ length: rows }, () => [])
  for (const [rowAddr, colAddr, rowSpan, colSpan, text] of boxes) {
    if (!cells[rowAddr]) continue
    cells[rowAddr].push({
      text: text ?? "",
      colSpan,
      rowSpan,
      colAddr,
      rowAddr,
    })
  }
  return buildTable(cells)
}

// ─── 신호 추출 단위 ───────────────────────────────────

describe("extractTableSignals", () => {
  it("밀도 높은 규칙 격자 — gridRegularity·rowSchemaConsistency 만점", () => {
    const table = buildTable(plain([
      ["이름", "부서", "직급"],
      ["김철수", "총무과", "주무관"],
      ["이영희", "기획과", "사무관"],
    ]))
    const s = extractTableSignals(table)
    assert.equal(s.gridRegularity, 1)
    assert.equal(s.rowSchemaConsistency, 1)
    assert.equal(s.textDensity, 1)
    assert.equal(s.mergedAnchorCount, 0)
    assert.equal(s.spanIrregularity, 0)
  })

  it("병합 커버 셀은 앵커에서 제외된다", () => {
    const table = buildTable([
      [{ text: "제목", colSpan: 2, rowSpan: 1 }],
      [{ text: "A", colSpan: 1, rowSpan: 1 }, { text: "B", colSpan: 1, rowSpan: 1 }],
    ])
    const s = extractTableSignals(table)
    // 2×2 격자에서 앵커는 3개 (제목 병합 + A + B)
    assert.equal(s.anchorCount, 3)
    assert.equal(s.mergedAnchorCount, 1)
    assert.ok(s.mergedCellRatio > 0 && s.mergedCellRatio < 1)
  })
})

// ─── 판별 사례 ────────────────────────────────────────

describe("classifyTable", () => {
  it("1. 극도로 희소하고 병합이 불규칙한 표 기반 도식 → non-tabular-layout", () => {
    // 비상연락망·조직도류 실측 구조 재현: 넓은 격자, 흩어진 박스, 층간 빈 행
    const table = scatterBoxes(14, 21, [
      [0, 9, 2, 3, "원장"],
      [3, 2, 2, 3, "경영지원부"],
      [3, 9, 2, 3, "기획조정본부"],
      [3, 16, 2, 3, "정보화사업단"],
      [6, 1, 2, 2, "총무팀"],
      [6, 6, 2, 2, "인사팀"],
      [6, 11, 2, 2, "예산팀"],
      [6, 16, 2, 2, "평가팀"],
      [10, 4, 1, 5, "비상연락 책임자"],
      [12, 12, 2, 6, "야간 당직실"],
    ])
    const result = classifyTable(table)
    assert.equal(result.kind, "non-tabular-layout")
    assert.ok(result.signals.textDensity <= 0.15, `밀도 과다: ${result.signals.textDensity}`)
    assert.ok(result.signals.spanIrregularity > 0, "병합 불규칙 근거 없음")
    assert.ok(result.reasons.length > 0)
  })

  it("2. 밀도가 높은 일반 데이터 표 → semantic-table", () => {
    const table = buildTable(plain([
      ["품명", "규격", "수량", "비고"],
      ["케이블", "5m", "10", "-"],
      ["커넥터", "RJ45", "20", "-"],
      ["브래킷", "표준", "4", "별도 발주"],
      ["패널", "600x600", "2", "-"],
    ]))
    const result = classifyTable(table)
    assert.equal(result.kind, "semantic-table")
    assert.equal(result.signals.textDensity, 1)
  })

  it("3. 본문 값이 비어 있지만 규칙적인 2열 입력 표 → semantic-table", () => {
    // 빈 입력 양식 — 낮은 밀도만으로 비표 판정하면 안 된다.
    // 값 열이 앵커를 가져 파서가 보존한 형태(keepAnchoredEmptyCols, #47)로 구성한다
    const rowsText = [
      ["성명", ""],
      ["생년월일", ""],
      ["연락처", ""],
      ["주소", ""],
      ["신청 내용", ""],
      ["비고", ""],
    ]
    const table = buildTable(plain(rowsText), { keepAnchoredEmptyCols: true })
    const result = classifyTable(table)
    assert.equal(result.kind, "semantic-table")
    assert.ok(result.signals.textDensity <= 0.55)
  })

  it("4. 병합 헤더를 가진 실제 데이터 표 → semantic-table", () => {
    const cells: CellContext[][] = [
      [{ text: "2026년 부서별 인원 현황", colSpan: 4, rowSpan: 1 }],
      [{ text: "구분", colSpan: 1, rowSpan: 1 }, { text: "계", colSpan: 1, rowSpan: 1 }, { text: "정원", colSpan: 1, rowSpan: 1 }, { text: "현원", colSpan: 1, rowSpan: 1 }],
      [{ text: "총계", colSpan: 1, rowSpan: 1 }, { text: "24", colSpan: 1, rowSpan: 1 }, { text: "22", colSpan: 1, rowSpan: 1 }, { text: "20", colSpan: 1, rowSpan: 1 }],
      [{ text: "기획팀", colSpan: 1, rowSpan: 1 }, { text: "8", colSpan: 1, rowSpan: 1 }, { text: "8", colSpan: 1, rowSpan: 1 }, { text: "7", colSpan: 1, rowSpan: 1 }],
      [{ text: "총무팀", colSpan: 1, rowSpan: 1 }, { text: "9", colSpan: 1, rowSpan: 1 }, { text: "8", colSpan: 1, rowSpan: 1 }, { text: "8", colSpan: 1, rowSpan: 1 }],
      [{ text: "회계팀", colSpan: 1, rowSpan: 1 }, { text: "7", colSpan: 1, rowSpan: 1 }, { text: "6", colSpan: 1, rowSpan: 1 }, { text: "5", colSpan: 1, rowSpan: 1 }],
    ]
    const result = classifyTable(buildTable(cells))
    assert.equal(result.kind, "semantic-table")
    assert.ok(!result.reasons.includes("span-irregularity"))
  })

  it("5. 빈 행 하나를 포함하지만 행 스키마가 반복되는 표 → semantic-table", () => {
    const rowsText = [
      ["일자", "공사명", "상태"],
      ["8/10", "도로 포장", "완료"],
      ["", "", ""],
      ["8/14", "조명 교체", "진행"],
      ["8/18", "배수로 정비", "착수"],
    ]
    const result = classifyTable(buildTable(plain(rowsText)))
    assert.equal(result.kind, "semantic-table")
    assert.equal(result.signals.spacerRowCount, 1)
  })

  it("6. 1×1 외부 표 안의 중첩 조직 구조 → 외부와 내부 모두 non-tabular-layout", () => {
    const innerOrgChart = scatterBoxes(10, 15, [
      [0, 6, 2, 3, "CEO"],
      [3, 1, 2, 3, "사업실"],
      [3, 9, 2, 3, "경영본부"],
      [7, 0, 2, 2, "마케팅팀"],
      [7, 5, 2, 2, "영업팀"],
      [7, 11, 2, 2, "전략팀"],
    ])
    const outer: IRTable = {
      rows: 1,
      cols: 1,
      cells: [[{
        text: "",
        colSpan: 1,
        rowSpan: 1,
        blocks: [{ type: "table", table: innerOrgChart } as IRBlock],
      }]],
      hasHeader: false,
    }
    const results = classifyTableBlocks([{ type: "table", table: outer } as IRBlock])
    // 외부 래퍼 + 내부 도식 — DFS pre-order로 평탄되어 반환된다
    assert.equal(results.length, 2)
    assert.equal(results[0].kind, "non-tabular-layout")
    assert.ok(results[0].reasons.includes("nested-structure-wrapper"))
    assert.equal(results[1].kind, "non-tabular-layout")
  })

  it("7. 구조 신호가 부족한 작은/희소 표 → uncertain", () => {
    const sparse = buildTable(plain([
      ["", "", ""],
      ["", "메모", ""],
      ["", "", ""],
    ]))
    assert.equal(classifyTable(sparse).kind, "uncertain")

    const tinyWide = buildTable(plain([
      ["", "", "", ""],
      ["항목", "", "", ""],
      ["", "", "", ""],
      ["", "", "", ""],
    ]))
    assert.equal(classifyTable(tinyWide).kind, "uncertain")
  })

  it("8. 문맥 키워드만 있고 구조적 근거가 없는 표 → 비표 확정 금지", () => {
    const cleanData = buildTable(plain([
      ["구분", "인원", "비고"],
      ["1팀", "5", "신설"],
      ["2팀", "4", "-"],
      ["3팀", "6", "-"],
    ]))
    const result = classifyTable(cleanData, {
      precedingText: ["우리 기관의 조직도와 편성 현황이다"],
      followingText: ["위 표는 인력 운용 실태를 보여준다"],
    })
    assert.notEqual(result.kind, "non-tabular-layout")
    assert.ok(
      !result.reasons.includes("diagram-context-keyword"),
      "구조 근거 없이 문맥 근거만 남으면 안 된다",
    )
  })

  it("9. 입력 객체를 변경하지 않는다 (순수 함수)", () => {
    const table = scatterBoxes(8, 12, [
      [0, 4, 2, 3, "대표"],
      [4, 1, 2, 2, "팀 A"],
      [4, 7, 2, 2, "팀 B"],
    ])
    const before = JSON.stringify(table)
    extractTableSignals(table)
    classifyTable(table, { precedingText: ["조직도"] })
    classifyTableBlocks([{ type: "table", table } as IRBlock])
    assert.equal(JSON.stringify(table), before)
  })

  it("10. 동일 입력에는 결정적 결과와 안정적인 reason code", () => {
    const table = scatterBoxes(12, 18, [
      [0, 7, 2, 4, "기관장"],
      [3, 1, 2, 3, "운영지원과"],
      [3, 13, 2, 3, "정책기획단"],
      [8, 5, 1, 4, "당직실"],
    ])
    const a = classifyTable(table)
    const b = classifyTable(table)
    assert.deepStrictEqual(a, b)
    assert.deepEqual(a.reasons, b.reasons)
    for (const r of a.reasons) {
      assert.match(r, /^[a-z][a-z-]*$/, `reason code 형식 불안정: ${r}`)
    }
  })

  it("음성 대조군 — dummy.hwpx 일반 표(2×2, 밀도 1.0)는 비표가 아니다", async () => {
    const dummyPath = resolve(FIXTURES_DIR, "dummy.hwpx")
    const parsed = await parse(readFileSync(dummyPath))
    assert.ok(parsed.success)
    const tables = parsed.blocks.filter((b): b is IRBlock & { table: IRTable } => b.type === "table" && !!b.table)
    assert.ok(tables.length >= 1)
    for (const b of tables) {
      const result = classifyTable(b.table)
      assert.notEqual(result.kind, "non-tabular-layout", `일반 표가 비표로 오판: ${JSON.stringify(result.signals)}`)
    }
  })

  it("음성 대조군 — 반복 행 스키마의 중간 밀도(0.6) 데이터 표는 semantic-table", () => {
    const rowsText = [
      ["항목", "1분기", "2분기", "3분기", "4분기"],
      ["매출", "120", "", "135", ""],
      ["비용", "80", "", "82", ""],
      ["인건비", "40", "", "42", ""],
      ["투자", "10", "", "12", ""],
      ["잔액", "30", "", "41", ""],
    ]
    const table = buildTable(plain(rowsText))
    const s = extractTableSignals(table)
    assert.ok(s.textDensity >= 0.5 && s.textDensity <= 0.85, `밀도 범위 이탈: ${s.textDensity}`)
    assert.equal(classifyTable(table).kind, "semantic-table")
  })
})
