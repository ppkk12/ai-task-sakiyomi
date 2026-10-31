"use client";

import { useMemo, useState } from "react";
import { WINDOW_LABEL, type WindowKey } from "@/lib/catalog";
import { calculate, recommend, representativeRows, type Recommendation, type Row } from "@/lib/calc";
import { fmtJpy, fmtMinutes, fmtPct, fmtRatio, fmtTokens, fmtUsd, pctTone } from "@/lib/format";
import { PROVIDER_LABEL } from "@/lib/llm";
import { LEVEL_LABEL, LEVELS, TASK_TYPE_LABEL, type EngineResult, type PcSpec } from "@/lib/types";

const WINDOWS: WindowKey[] = ["fiveHour", "weekly", "monthly"];
const PAGE = 12;
type SortKey = "score" | "time" | "cost" | "window";

/**
 * 試算結果に基づき最適なモデル提案・タスク予測・各モデル比較表を表示するコンポーネント。
 *
 * @param result LLMによるタスク見積もり結果
 * @param owned ユーザーが保有するモデル・プラン識別子一覧
 * @param spec ローカル計算用のPCスペック情報
 * @param usdJpy 日本円換算用の為替レート（USD/JPY）
 */
export function Results({ result, owned, spec, usdJpy }: { result: EngineResult; owned: string[]; spec: PcSpec; usdJpy: number }) {
  const p = result.prediction;
  const rows = useMemo(() => calculate({ prediction: p, owned, spec, usdJpy }), [p, owned, spec, usdJpy]);
  const { best, alternative } = useMemo(() => recommend(rows), [rows]);

  return (
    <div className="space-y-6">
      {best ? (
        <BestCard row={best} usdJpy={usdJpy} reason={reasonFor(best, rows, usdJpy)} />
      ) : (
        <div className="panel p-5 text-sm">使っているAIが選ばれていません。上の「使っているAI」から選ぶと、その中でのおすすめを出します。</div>
      )}
      {best && alternative && (
        <p className="-mt-3 px-1 text-sm text-stone-500">
          ちなみに <span className="text-stone-800 dark:text-stone-200">{alternative.row.model.name}（{alternative.row.levelLabel}・{alternative.row.plan.name}）</span>
          が使えるなら、{altText(alternative)}になります。
        </p>
      )}
      <PredictionCard result={result} />
      <CompareTable rows={rows} usdJpy={usdJpy} bestKey={best?.key} />
    </div>
  );
}

function altText({ timeRatio, costRatio, costLabel }: NonNullable<Recommendation["alternative"]>): string {
  const cost = costRatio < 0.01 ? (costLabel === "コスト" ? "（月額内で）追加料金なし" : "枠消費がほぼゼロ") : `${costLabel}が${fmtRatio(costRatio)}`;
  if (timeRatio > 0.65) return cost;
  return costRatio <= 0.55 ? `時間が${fmtRatio(timeRatio)}・${cost}` : `時間が${fmtRatio(timeRatio)}`;
}

function reasonFor(best: Row, rows: Row[], usdJpy: number): string {
  const parts: string[] = [];
  const low = rows.find((r) => r.model.id === best.model.id && r.plan.id === best.plan.id && r.level === "low");
  if (!best.model.reasoning) {
    parts.push("手持ちの中で、時間・使用枠・完成度のバランスがいちばん良い");
  } else if (best.level !== "low" && low && low.attempts > best.attempts + 0.3) {
    parts.push(`Lowだとやり直しが平均${low.attempts.toFixed(1)}回に増えて、かえって時間と枠を使う`);
  } else if (best.level === "low") {
    parts.push(best.complexity <= 2 ? "簡単な内容なので、Lowでも一回で終わる見込みが高い" : "このモデルならLowでもやり直しが少なく、待ち時間を節約できる");
  } else if (best.level === "high") {
    parts.push("込み入った内容なので、Highで一回で通すほうが結果的に早い");
  } else {
    parts.push("品質と枠消費のバランスがいちばん良い");
  }
  if (best.maxWindowPct > 100) parts.push("ただし枠を超える見込みなので、何回かに分けて進めることになりそう");
  else if (best.plan.payAsYouGo) parts.push(`料金は${fmtJpy(best.payUsd, usdJpy)}ほどで収まる見込み`);
  else if (best.plan.free) parts.push("無料プランの枠内で収まりそう");
  else if (best.maxWindowPct > 70) parts.push("ただし枠をかなり使うので、ほかの作業との兼ね合いに注意");
  return parts.join("。") + "。";
}

function BestCard({ row, usdJpy, reason }: { row: Row; usdJpy: number; reason: string }) {
  return (
    <section className="panel border-l-4 border-l-accent p-5 sm:p-6">
      <p className="eyebrow">使っているAIの中でのおすすめ</p>
      <h2 className="mt-2 text-2xl font-bold tracking-tight sm:text-3xl">
        {row.model.name}
        <span className="ml-2 text-accent">{row.levelLabel}</span>
      </h2>
      <p className="mt-1 text-sm text-stone-500">{row.plan.name}で使う場合</p>
      <p className="mt-4 max-w-2xl text-sm leading-relaxed">{reason}</p>
      <dl className="mt-5 grid grid-cols-2 border-t border-stone-200 sm:grid-cols-4 dark:border-stone-800">
        <Stat label="完了までの目安" value={fmtMinutes(row.minutes.total)}
          sub={`AI ${fmtMinutes(row.minutes.ai)} ・ 確認 ${fmtMinutes(row.minutes.human)}${row.minutes.local ? ` ・ ビルド ${fmtMinutes(row.minutes.local)}` : ""}`} />
        {row.plan.payAsYouGo || !Object.keys(row.windows).length ? (
          <Stat label={row.plan.payAsYouGo ? "API料金" : "料金"} value={fmtJpy(row.payUsd, usdJpy)} sub={row.plan.payAsYouGo ? fmtUsd(row.payUsd) : "電気代のみ"} />
        ) : (
          WINDOWS.filter((w) => row.windows[w] !== undefined).map((w) => (
            <Stat key={w} label={WINDOW_LABEL[w]} value={fmtPct(row.windows[w])} tone={pctTone(row.windows[w])} />
          ))
        )}
        <Stat label="やり直し込みの回数" value={`${row.attempts.toFixed(1)}回`} sub={`計 ${fmtTokens(row.tokens.total)} トークン`} />
      </dl>
    </section>
  );
}

function Stat({ label, value, sub, tone = "" }: { label: string; value: string; sub?: string; tone?: string }) {
  return (
    <div className="border-b border-stone-200 py-3 pr-3 dark:border-stone-800">
      <dt className="text-xs text-stone-500">{label}</dt>
      <dd className={`num mt-0.5 text-xl font-semibold ${tone}`}>{value}</dd>
      {sub && <dd className="mt-0.5 text-xs text-stone-500">{sub}</dd>}
    </div>
  );
}

function PredictionCard({ result }: { result: EngineResult }) {
  const p = result.prediction;
  return (
    <section className="panel p-5">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h3 className="font-semibold">この先の見立て</h3>
        <span className="text-xs text-stone-500">
          判定：{PROVIDER_LABEL[result.engine]}{result.engineModel ? `（${result.engineModel}）` : ""}
        </span>
      </div>
      {result.fallbackReason && (
        <p className="mt-2 border-l-2 border-amber-500 pl-3 text-xs text-amber-800 dark:text-amber-300">
          外部APIが使えなかったので、簡易判定に切り替えました：{result.fallbackReason}
        </p>
      )}
      <p className="mt-3 text-sm">{p.summary}</p>
      <dl className="mt-4 grid grid-cols-2 gap-x-6 gap-y-3 text-sm sm:grid-cols-4">
        <Info k="タスクの種類" v={TASK_TYPE_LABEL[p.taskType]} />
        <Info k="難しさ" v={`${p.complexity} / 5`} />
        <Info k="一回で終わるか" v={p.oneShotLikely ? "終わりやすい" : "やり直しが出やすい"} />
        <Info k="やり取り / ツール実行" v={`${p.expectedTurns}往復 / ${p.toolCalls}回`} />
        <Info k="入力（履歴込み）" v={fmtTokens(p.tokens.input)} />
        <Info k="ファイル読み込み" v={fmtTokens(p.tokens.fileRead)} />
        <Info k="出力" v={fmtTokens(p.tokens.output)} />
        <Info k="思考（Medium）" v={fmtTokens(p.tokens.thinking)} />
      </dl>
      <div className="mt-5 text-sm">
        {LEVELS.map((lv) => (
          <div key={lv} className="grid gap-x-4 gap-y-0.5 border-t border-stone-200 py-2.5 sm:grid-cols-[5rem_11rem_1fr] dark:border-stone-800">
            <span className="font-medium">{LEVEL_LABEL[lv]}</span>
            <span className="text-xs whitespace-nowrap text-stone-500 sm:pt-0.5">
              やり直し率 <span className="num">{Math.round(p.levels[lv].retryRate * 100)}%</span> ・ 平均 <span className="num">{p.levels[lv].expectedAttempts.toFixed(1)}</span>回
            </span>
            <span className="text-xs text-stone-600 sm:pt-0.5 dark:text-stone-400">{p.levels[lv].note}</span>
          </div>
        ))}
      </div>
      {p.risks.length > 0 && (
        <ul className="mt-3 space-y-1 text-xs text-stone-500">
          {p.risks.map((r) => <li key={r}>— {r}</li>)}
        </ul>
      )}
    </section>
  );
}

function Info({ k, v }: { k: string; v: string }) {
  return (
    <div>
      <dt className="text-xs text-stone-500">{k}</dt>
      <dd className="num mt-0.5">{v}</dd>
    </div>
  );
}

/**
 * 全モデルの計算結果をソートやフィルター条件に応じてテーブル表示するコンポーネント。
 *
 * @param rows 算出された各モデルの試算結果一覧
 * @param usdJpy 日本円換算用の為替レート（USD/JPY）
 * @param bestKey 最適と判定されたモデル・プランの識別キー
 */
function CompareTable({ rows, usdJpy, bestKey }: { rows: Row[]; usdJpy: number; bestKey?: string }) {
  const [ownedOnly, setOwnedOnly] = useState(false);
  const [allPlans, setAllPlans] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const [sort, setSort] = useState<SortKey>("score");

  const sorted = useMemo(() => {
    let list = allPlans ? rows : representativeRows(rows);
    if (ownedOnly) list = list.filter((r) => r.owned);
    const by: Record<SortKey, (r: Row) => number> = {
      score: (r) => r.score,
      time: (r) => r.minutes.total,
      cost: (r) => r.apiUsd,
      window: (r) => (Object.keys(r.windows).length ? r.maxWindowPct : -1),
    };
    return [...list].sort((a, b) => by[sort](a) - by[sort](b));
  }, [rows, ownedOnly, allPlans, sort]);
  const shown = showAll ? sorted : sorted.slice(0, PAGE);

  return (
    <section className="panel overflow-hidden">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 p-4">
        <h3 className="font-semibold">全モデルの比較</h3>
        <label className="flex items-center gap-1.5 text-xs"><input type="checkbox" className="accent-stone-900" checked={ownedOnly} onChange={(e) => setOwnedOnly(e.target.checked)} />使っているAIだけ</label>
        <label className="flex items-center gap-1.5 text-xs"><input type="checkbox" className="accent-stone-900" checked={allPlans} onChange={(e) => setAllPlans(e.target.checked)} />プランごとに分ける</label>
        <select aria-label="並び順" className="field ml-auto w-auto py-1 text-xs" value={sort} onChange={(e) => setSort(e.target.value as SortKey)}>
          <option value="score">おすすめ順</option>
          <option value="time">早い順</option>
          <option value="cost">API料金が安い順</option>
          <option value="window">枠を使わない順</option>
        </select>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[860px] text-sm">
          <thead className="border-y border-stone-200 text-xs text-stone-500 dark:border-stone-800">
            <tr className="text-left">
              <th className="px-4 py-2 font-normal">モデル</th>
              <th className="px-2 py-2 font-normal">使い方</th>
              <th className="px-2 py-2 text-right font-normal">回数</th>
              <th className="px-2 py-2 text-right font-normal">5時間枠</th>
              <th className="px-2 py-2 text-right font-normal">1週間枠</th>
              <th className="px-2 py-2 text-right font-normal">1ヶ月枠</th>
              <th className="px-2 py-2 text-right font-normal">API料金</th>
              <th className="px-4 py-2 text-right font-normal">完了まで</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((r) => (
              <tr key={r.key} className={`border-b border-stone-100 last:border-0 dark:border-stone-800/60 ${r.key === bestKey ? "bg-accent-soft" : ""} ${r.owned ? "" : "text-stone-400 dark:text-stone-500"}`}>
                <td className="px-4 py-2">
                  {r.key === bestKey && <span className="mr-1.5 text-accent">●</span>}
                  <span className="font-medium">{r.model.name}</span>
                  <span className="ml-1.5 text-xs text-stone-500">{r.levelLabel}</span>
                </td>
                <td className="px-2 py-2 text-xs">
                  {r.plan.name}
                  {!r.owned && <span className="ml-1 text-stone-400">（未契約）</span>}
                </td>
                <td className="num px-2 py-2 text-right">{r.attempts.toFixed(1)}</td>
                {WINDOWS.map((w) => (
                  <td key={w} className={`num px-2 py-2 text-right ${r.owned ? pctTone(r.windows[w]) : ""}`}>{fmtPct(r.windows[w])}</td>
                ))}
                <td className="num px-2 py-2 text-right whitespace-nowrap">
                  {r.model.localMemGb ? "—" : (
                    <>
                      {fmtJpy(r.apiUsd, usdJpy)} <span className="text-xs text-stone-400">{fmtUsd(r.apiUsd)}</span>
                    </>
                  )}
                </td>
                <td className="num px-4 py-2 text-right font-medium whitespace-nowrap">{fmtMinutes(r.minutes.total)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {sorted.length > PAGE && (
        <button type="button" className="w-full border-t border-stone-200 py-2.5 text-xs text-stone-600 hover:bg-stone-50 dark:border-stone-800 dark:text-stone-400 dark:hover:bg-stone-800/40" onClick={() => setShowAll((v) => !v)}>
          {showAll ? "上位だけ表示" : `残り${sorted.length - PAGE}件も表示`}
        </button>
      )}
      <p className="border-t border-stone-200 p-4 text-xs leading-relaxed text-stone-500 dark:border-stone-800">
        API料金はサブスクで使う場合も「API換算ならこのくらい」の参考値です（サブスク内なら追加料金はかかりません）。
        枠の大きさ・料金・速度は公開情報をもとにした目安で、時期や混み具合で変わります。
      </p>
    </section>
  );
}
