// paid_templates.js
// 有料導線（課金ゲート/案内）用の固定テキスト
// 重要：ここでは「具体アドバイス・例文・判断」を出さない。
// それは PAID_INPUT 以降（有料AI/設計）でやる。

function safe(v, fallback = "未入力") {
  if (v === null || v === undefined) return fallback;
  const s = String(v).trim();
  return s ? s : fallback;
}

function compactFacts(answers = {}) {
  const a = answers || {};
  const rel = safe(a.relationshipStage, "未入力");
  const cat = safe(a.category, "未入力");
  const goal = safe(a.goal, "未入力");
  const snippet = safe(a.problemSnippet, "未入力");

  return (
    `（いま取れてる情報）\n` +
    `・カテゴリ：${cat}\n` +
    `・関係：${rel}\n` +
    `・目的：${goal}\n` +
    `・状況：${snippet}`
  );
}

function buildPaidContent(answers = {}) {
  return (
    `ここから先、有料パートよ💋\n` +
    `まずは“素材”を出しなさい。\n\n` +
    compactFacts(answers) +
    `\n\n` +
    `次に送ってほしいもの（どれか1つでOK）：\n` +
    `1) 相手の返信が来てる → 本文をそのまま貼る（スクショでもOK）\n` +
    `2) 既読/未読で止まってる → いつから？（例：2日/1週間）\n` +
    `3) まだ送ってない → 送りたい内容を1行で（何を達成したいか）\n\n` +
    `※ここでは例文は出さない。状況を見て“勝つ形”に組む💋`
  );
}

module.exports = {
  buildPaidContent,
};


