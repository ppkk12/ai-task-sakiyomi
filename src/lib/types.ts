export type Level = "low" | "medium" | "high";
export const LEVELS: Level[] = ["low", "medium", "high"];
export const LEVEL_LABEL: Record<Level, string> = { low: "Low", medium: "Medium", high: "High" };

export type TaskType =
  | "single_question"
  | "code_generation"
  | "multi_file_design"
  | "debugging"
  | "writing"
  | "analysis";

export const TASK_TYPE_LABEL: Record<TaskType, string> = {
  single_question: "単発の質問",
  code_generation: "コード生成",
  multi_file_design: "複数ファイル設計",
  debugging: "デバッグ・原因調査",
  writing: "文章作成・翻訳",
  analysis: "調査・分析",
};

export interface LevelForecast {
  /** 手戻り（やり直し）が発生する確率 0〜1 */
  retryRate: number;
  /** 完了までの試行回数の期待値（1 = 一発で終わる） */
  expectedAttempts: number;
  note: string;
}

/** 判定エンジン（無料AI or ヒューリスティック）が返す「この先の展開」予測 */
export interface Prediction {
  taskType: TaskType;
  summary: string;
  /** 1〜5 */
  complexity: number;
  oneShotLikely: boolean;
  /** Mediumで一発完了したときの往復ターン数 */
  expectedTurns: number;
  /** ファイル読み書き・コマンド実行などのツール実行回数 */
  toolCalls: number;
  levels: Record<Level, LevelForecast>;
  /** Mediumで一発完了したときの累計トークン */
  tokens: { input: number; output: number; thinking: number; fileRead: number };
  /** 1ターンあたり人間が確認・指示に使う分数 */
  humanMinutesPerTurn: number;
  /** ローカルでのビルド・テスト実行回数 */
  buildTestRuns: number;
  risks: string[];
}

export type EngineId = "heuristic" | "gemini" | "openrouter" | "groq";

/**
 * タスク予測の実行結果
 * 採用された判定エンジンの予測データと、実行時のモデル名やフォールバック発生理由を格納する
 */
export interface EngineResult {
  prediction: Prediction;
  engine: EngineId;
  engineModel?: string;
  /** フォールバックした場合の理由 */
  fallbackReason?: string;
}

export interface PcSpec {
  enabled: boolean;
  /** CPU・GPUなどを個別に選ぶ詳細モード */
  detail: boolean;
  preset: string;
  os: string;
  cpu: string;
  gpu: string;
  ramGb: number;
}

/**
 * アプリケーションの共通設定
 * 優先判定エンジン、各種AIサービスのAPIキーと指定モデル、および試算用USD/JPY為替レートを保持する
 */
export interface Settings {
  engine: EngineId;
  keys: { gemini: string; openrouter: string; groq: string };
  models: { gemini: string; openrouter: string; groq: string };
  usdJpy: number;
}
