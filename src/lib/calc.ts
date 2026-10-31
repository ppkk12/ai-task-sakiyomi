import { LOCAL_PLAN, MODELS, PLANS, type ModelInfo, type PlanInfo, type WindowKey } from "./catalog";
import { buildFactor, localMemory, localTps } from "./specs";
import { LEVEL_LABEL, LEVELS, type Level, type PcSpec, type Prediction, type TaskType } from "./types";

/** 推論レベルごとの思考トークン倍率と、モデル呼び出し1回あたりの待ち時間（秒） */
const LEVEL_THINK: Record<Level, number> = { low: 0.3, medium: 1, high: 2.4 };
const LEVEL_LATENCY: Record<Level, number> = { low: 2, medium: 4, high: 8 };
/** ビルド・テスト1回あたりの基準時間（秒、標準ノートPC） */
const BUILD_SECONDS: Record<TaskType, number> = {
  single_question: 0, writing: 0, analysis: 20, code_generation: 30, debugging: 45, multi_file_design: 90,
};

export interface Row {
  key: string;
  model: ModelInfo;
  level: Level;
  /** 「Low」「High」など。推論レベルを選べないモデルは「標準」 */
  levelLabel: string;
  plan: PlanInfo;
  owned: boolean;
  attempts: number;
  tokens: { input: number; output: number; thinking: number; total: number };
  /** API料金換算（USD）。サブスクの枠消費計算にも使う */
  apiUsd: number;
  /** 実際に支払う追加料金（従量課金のみ。サブスクは0） */
  payUsd: number;
  windows: Partial<Record<WindowKey, number>>;
  maxWindowPct: number;
  minutes: { ai: number; human: number; local: number; total: number };
  score: number;
  complexity: number;
}

export interface CalcInput {
  prediction: Prediction;
  owned: string[];
  spec: PcSpec;
  usdJpy: number;
}

/** 全モデル × 全レベル × 利用経路（プラン）の消費量を計算する */
export function calculate({ prediction: p, owned, spec }: CalcInput): Row[] {
  const rows: Row[] = [];
  const ownedSet = new Set(owned);
  const factor = spec.enabled ? buildFactor(spec) : 0;
  const localMin = (p.buildTestRuns * BUILD_SECONDS[p.taskType] * factor) / 60;

  for (const model of MODELS) {
    const local = model.localMemGb !== undefined;
    // ローカルモデルはPCスペックを入れたときだけ、かつメモリに載るものだけ
    if (local && (!spec.enabled || localMemory(spec) < model.localMemGb!)) continue;
    const plans = local ? [LOCAL_PLAN] : PLANS.filter((pl) => pl.models.includes(model.id));
    const tps = local ? localTps(spec, model.localMemGb) * (model.localSpeed ?? 1) : model.tps;

    for (const level of model.reasoning ? LEVELS : (["medium"] as Level[])) {
      const lv = p.levels[level];
      // 品質の低いモデルほど手戻りが増える（基準品質0.9）
      const attempts = Math.max(1, 1 + (lv.expectedAttempts - 1) * (1 + (0.9 - model.quality) * 4) + Math.max(0, 0.95 - model.quality) * p.complexity * 0.5);
      // やり直しは途中からの再実行が多いので、2回目以降は7割のコストとみなす
      const scale = 1 + (attempts - 1) * 0.7;

      const input = (p.tokens.input + p.tokens.fileRead) * scale;
      const output = p.tokens.output * scale;
      const thinking = p.tokens.thinking * LEVEL_THINK[level] * model.thinkFactor * scale;
      const apiUsd = (input * model.priceIn + (output + thinking) * model.priceOut) / 1e6;

      const calls = (p.expectedTurns + p.toolCalls) * scale;
      const ai = ((output + thinking) / tps + calls * LEVEL_LATENCY[level]) / 60;
      const human = p.expectedTurns * scale * p.humanMinutesPerTurn;
      const build = localMin * scale;
      const minutes = { ai, human, local: build, total: ai + human + build };

      for (const plan of plans) {
        const windows: Row["windows"] = {};
        for (const [k, budget] of Object.entries(plan.windows) as [WindowKey, number][]) {
          windows[k] = (apiUsd / budget) * 100;
        }
        const maxWindowPct = Math.max(0, ...Object.values(windows));
        const payUsd = plan.payAsYouGo ? apiUsd : 0;
        rows.push({
          key: `${model.id}:${level}:${plan.id}`,
          model, level, plan,
          levelLabel: model.reasoning ? LEVEL_LABEL[level] : "標準",
          owned: local || ownedSet.has(plan.id),
          attempts,
          tokens: { input, output, thinking, total: input + output + thinking },
          apiUsd, payUsd, windows, maxWindowPct, minutes,
          score: 0,
          complexity: p.complexity,
        });
      }
    }
  }
  for (const r of rows) r.score = score(r);
  return rows;
}

/**
 * おすすめ度（小さいほど良い）。
 * 時間（分）を軸に、枠の圧迫と従量課金の支払いをペナルティとして加算する。
 * 失敗しやすいモデルは時間・枠の両方が膨らむので自然と不利になる。
 */
function score(r: Row): number {
  const pct = r.maxWindowPct;
  // 半分までは軽め、それ以上は他の作業ができなくなるので重く、超過は実質不可
  const windowPenalty = pct > 100 ? 1000 + pct : pct <= 50 ? pct * 0.15 : 7.5 + (pct - 50) * 0.6;
  const moneyPenalty = r.payUsd * 150 / 20; // 約20円 = 1分
  // 複雑なタスクほど、性能の低いモデルは完成度不足（見落とし・後日の修正）のリスクが大きい
  const qualityPenalty = Math.max(0, 0.95 - r.model.quality) * r.complexity * 20;
  return r.minutes.total + windowPenalty + moneyPenalty + qualityPenalty;
}

export interface Recommendation {
  best: Row | null;
  /** 未契約のAIで大幅に節約できる候補（なければ null） */
  alternative: { row: Row; timeRatio: number; costRatio: number; costLabel: "コスト" | "枠消費" } | null;
}

/**
 * 契約済みプランの中からスコア最良の組み合わせを決定し、未契約で大幅な改善が見込める乗り換え候補を抽出する。
 *
 * @param rows 計算済みの評価行リスト。契約済みプランを含まない場合はいずれも null を返す
 * @returns 契約済みの最良行と、大幅改善を満たす未契約候補
 */
export function recommend(rows: Row[]): Recommendation {
  const ownedRows = rows.filter((r) => r.owned).sort((a, b) => a.score - b.score);
  const best = ownedRows[0] ?? null;
  if (!best) return { best: null, alternative: null };

  // 「コスト」は従量課金なら支払額、サブスクなら枠消費率で比べる
  const costLabel = best.plan.payAsYouGo ? "コスト" : "枠消費";
  const costOf = (r: Row) => (best.plan.payAsYouGo ? r.payUsd : r.plan.payAsYouGo ? Infinity : r.maxWindowPct);
  const bestCost = Math.max(costOf(best), 1e-6);

  // 「圧倒的に」節約できる場合のみ：時間が6割程度以下かコストが半分以下、かつもう一方も悪化しない
  let alternative: Recommendation["alternative"] = null;
  for (const r of representativeRows(rows).filter((x) => !x.owned && x.maxWindowPct <= 100).sort((a, b) => a.score - b.score)) {
    const timeRatio = r.minutes.total / best.minutes.total;
    const costRatio = costOf(r) / bestCost;
    const big = (timeRatio <= 0.65 && costRatio <= 1.1) || (costRatio <= 0.5 && timeRatio <= 1.0 && (best.payUsd > 0.5 || best.maxWindowPct > 30));
    if (big && r.score < best.score * 0.75) {
      alternative = { row: r, timeRatio, costRatio, costLabel };
      break;
    }
  }
  return { best, alternative };
}

/**
 * 各モデル×レベルについて代表の利用経路を1つ選ぶ。
 * 手持ちがあれば手持ちの中で最良のもの、なければ枠に収まるいちばん安いサブスク（無ければ従量API）。
 */
export function representativeRows(rows: Row[]): Row[] {
  const groups = new Map<string, Row[]>();
  for (const r of rows) {
    const k = `${r.model.id}:${r.level}`;
    groups.set(k, [...(groups.get(k) ?? []), r]);
  }
  return [...groups.values()].map(pickRoute);
}

/**
 * 同一モデル・同一推論レベルのプラン候補から、代表行を1件選定する。
 * 契約済み（最小スコア）→ ウィンドウ枠内（100%以下）の月額最安サブスク → 従量課金の順に選択する。
 *
 * @param group 同一モデル・推論レベルに属する評価行の配列
 * @returns 優先条件を満たす代表評価行
 */
function pickRoute(group: Row[]): Row {
  const owned = group.filter((r) => r.owned);
  if (owned.length) return owned.reduce((a, b) => (b.score < a.score ? b : a));
  const subs = group.filter((r) => !r.plan.payAsYouGo && r.maxWindowPct <= 100).sort((a, b) => a.plan.monthlyUsd - b.plan.monthlyUsd);
  return subs[0] ?? group.find((r) => r.plan.payAsYouGo) ?? group[0];
}
