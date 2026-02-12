// paid_memory.js
const { trimHistory } = require("./paid_engine");

function normalize(text) {
  return (text || "").trim();
}

/**
 * 重要イベント検知（summary更新トリガ）
 */
function detectImportantEvent(userText) {
  const t = normalize(userText);
  if (!t) return false;

  if (/会えた|会った|デートした|会うことになった/.test(t)) return true;
  if (/返信きた|返事きた|返ってきた|連絡きた/.test(t)) return true;
  if (/既読ついた|未読|既読無視|ブロック|解除/.test(t)) return true;
  if (/告白|付き合うことになった|恋人になった|交際/.test(t)) return true;
  if (/別れた|破局|復縁|よりを戻/.test(t)) return true;
  if (/喧嘩|ケンカ|怒らせた|修羅場/.test(t)) return true;

  return false;
}

/**
 * paid.summary 自動更新
 * - 6往復ごと or 重要イベント
 * - 失敗しても本体を止めない
 */
async function updatePaidSummaryIfNeeded({ openai, session, userText, aiText, importantEventHit }) {
  const every = 6;
  const dueByTurns = session.paid.turns > 0 && session.paid.turns % every === 0;
  const dueByEvent = !!importantEventHit;

  if (dueByEvent && session.paid.turns - session.paid.lastImportantEventAtTurn < 2) return;
  if (!dueByTurns && !dueByEvent) return;

  const system = `
あなたは恋愛相談Botの「長期メモ作成」担当。
出力は短い日本語メモのみ。見出し・ラベル・箇条書きは禁止。
最大 600 文字。事実優先。推測は弱く（〜かも）に留める。
必須要素：関係性/相手特性/直近事実/現在フェーズ/今の方針/次の一手（いつ何を）/絶対NG（最大3）
`.trim();

  const history = trimHistory(session.paid.history, 12);
  const recent = history
    .slice(-10)
    .map((m) => `${m.role === "user" ? "ユーザー" : "サラ"}: ${m.content}`)
    .join("\n");

  const prompt = `
次の情報から、長期メモを更新して。
前提がブレないことが最優先。長くしない。
「次の一手」は具体（いつ/何を）を短く。
絶対NGは最大3つだけ。

現在メモ：
${session.paid.summary || "（なし）"}

固定情報（answers）：
${JSON.stringify(session.answers, null, 2)}

現在フェーズ：
${session.paid.phase}

直近ログ：
${recent}

今回ユーザー入力：
${userText}

今回サラ返信：
${aiText}
`.trim();

  try {
    const resp = await openai.responses.create({
      model: "gpt-4.1-mini",
      max_output_tokens: 420,
      input: [
        { role: "system", content: system },
        { role: "user", content: prompt },
      ],
    });

    const s = (resp.output_text || "").trim();
    if (s) session.paid.summary = s;

    if (dueByEvent) session.paid.lastImportantEventAtTurn = session.paid.turns;
  } catch (e) {
    // summary失敗は無視
  }
}

module.exports = {
  detectImportantEvent,
  updatePaidSummaryIfNeeded,
};
