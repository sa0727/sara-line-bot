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

  if (/会えた|会った|デートした|会うことになった|会う約束|予定決まった/.test(t)) return true;
  if (/返信きた|返事きた|返ってきた|連絡きた|電話した|電話きた/.test(t)) return true;
  if (/既読ついた|未読|既読無視|未読無視|ブロック|解除|音信不通/.test(t)) return true;
  if (/告白|付き合うことになった|恋人になった|交際|彼氏|彼女|正式に/.test(t)) return true;
  if (/別れた|破局|復縁|よりを戻|元彼|元カレ|元カノ/.test(t)) return true;
  if (/喧嘩|ケンカ|怒らせた|修羅場|気まずい|険悪|冷戦/.test(t)) return true;

  return false;
}

/**
 * paid.summary 自動更新
 * - 6往復ごと or 重要イベント
 */
async function updatePaidSummaryIfNeeded({ openai, session, userText, aiText, importantEventHit }) {
  const every = Number(process.env.PAID_SUMMARY_EVERY || 6);

  const turns = Number(session?.paid?.turns || 0);
  const dueByTurns = turns > 0 && turns % every === 0;
  const dueByEvent = !!importantEventHit;

  // 重要イベントの連打で暴れないようにクールダウン
  const lastEv = Number(session?.paid?.lastImportantEventAtTurn || 0);
  if (dueByEvent && turns - lastEv < 2) return;

  if (!dueByTurns && !dueByEvent) return;

  const system = `
あなたは恋愛相談Botの「長期メモ作成」担当。
出力は短い日本語メモのみ。見出し・ラベル・箇条書きは禁止。
最大600文字。事実優先。推測は弱く（〜かも）に留める。

必須（短く入れる）：
関係性/相手特性/直近事実（相手の返事内容があれば含める）/現在フェーズ/
今の方針（送るor待つ）/次の一手（いつ何を、文面があるなら短く）/絶対NG（最大3）
`.trim();

  const history = trimHistory(session?.paid?.history, 12);
  const recent = (Array.isArray(history) ? history : [])
    .slice(-10)
    .map((m) => `${m.role === "user" ? "ユーザー" : "サラ"}: ${m.content}`)
    .join("\n");

  const prompt = `
次の情報から、長期メモを更新して。
前提がブレないことが最優先。長くしない。
「次の一手」は具体（いつ/何を）を短く。文面があるなら短く入れる（1〜2文まで）。
絶対NGは最大3つだけ。

現在メモ：
${session?.paid?.summary || "（なし）"}

固定情報（answers）：
${JSON.stringify(session?.answers || {}, null, 2)}

現在フェーズ：
${session?.paid?.phase || "UNKNOWN"}

直近ログ：
${recent}

今回ユーザー入力：
${userText}

今回サラ返信：
${aiText}
`.trim();

  try {
    const resp = await openai.responses.create({
      model: process.env.PAID_SUMMARY_MODEL || "gpt-4.1-mini",
      max_output_tokens: Number(process.env.PAID_SUMMARY_MAX_TOKENS || 420),
      input: [
        { role: "system", content: system },
        { role: "user", content: prompt },
      ],
    });

    const s = normalize(resp.output_text);
    if (s) session.paid.summary = s;

    if (dueByEvent) session.paid.lastImportantEventAtTurn = turns;
  } catch (e) {
    // summary失敗は無視
  }
}

module.exports = {
  detectImportantEvent,
  updatePaidSummaryIfNeeded,
};


