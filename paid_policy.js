// paid_policy.js
const { PaidPhase } = require("./paid_state");

function safe(v, fallback = "不明") {
  if (v == null) return fallback;
  const s = String(v).trim();
  return s ? s : fallback;
}

/**
 * ハードルール：モデルに「絶対やる/絶対やらない」を強制する文字列
 */
function buildHardRules({ answers, phase }) {
  const stage = safe(answers?.relationshipStage, "");
  const isReunion = /別れた|復縁/.test(stage);

  // 「どっち/どちら」禁止（選ばせる質問を避ける）
  // 日程提案テンプレも提示しておくとブレない
  const noChoiceQuestion = `
【ハード制約】
- 相手に送る文面に「どっち」「どちら」を入れない（“選ばせる圧”になる）
- 日程提案はこう言い換える：
  「○日か○日あたり空いてたら嬉しい。都合いい日あれば教えて」
`.trim();

  // 宛先が曖昧な時だけ確認質問1つ
  const recipientClarify = `
- ユーザーが「送っていい？/コピペでいい？/スクショでいい？」と言った時：
  それが“サラに送る”のか“相手に送る文面”なのか判定できない場合だけ
  最初に確認質問を1つだけする（それ以外の“どっちがいい？”は禁止）
`.trim();

  // 復縁は圧ワードさらに厳禁
  const reunionExtra = isReunion
    ? `
- 復縁では「戻りたい」「やり直したい」「なんで返さない」等の圧ワードは禁止（地雷）
`.trim()
    : "";

  // フェーズ別
  const phaseRules =
    phase === PaidPhase.WAITING_REPLY
      ? `
- 返信待ちでは追撃・催促をしない。送るなら“低圧ピン1通”まで。
`.trim()
      : phase === PaidPhase.BEFORE_SEND
      ? `
- 送信前では、文面を1案で提示して進める（確認で止めない）
`.trim()
      : `
- 返信後は相手の温度に合わせて、短く具体に次の一手を出す
`.trim();

  return [noChoiceQuestion, recipientClarify, reunionExtra, phaseRules].filter(Boolean).join("\n");
}

/**
 * 文章パターン（モデルの口調/制約を補助）
 * ここは今後増やしてOK
 */
function buildMessagePatterns() {
  return `
【推奨パターン（短く・低圧）】
- 低圧ピン：『忙しかった？大丈夫？落ち着いたらでいいからね』
- 低圧誘い：『落ち着いたら、軽くお茶でもどう？無理ならまたタイミング教えて』
- 日程提案（禁止語回避）：『○日か○日あたり空いてたら嬉しい。都合いい日あれば教えて』
`.trim();
}

/**
 * 温度スコア（0=低温〜1=高温のざっくり）
 */
function inferTemperatureScore({ userText, answers, phase }) {
  const t = (userText || "").trim();
  // 明らかに前向き
  if (/会いたい|いつ空いてる|会える|行きたい|楽しみ/.test(t)) return 1;

  // 返信後はやや上げ
  if (phase === PaidPhase.AFTER_REPLY) return 1;

  // それ以外は低温寄り
  return 0;
}

function buildTemperatureGuidance(score) {
  if (score >= 1) {
    return `
【温度ガイド】
- 明るく軽く、具体は出す
- ただし圧は上げない（長文/詰め/催促はNG）
`.trim();
  }
  return `
【温度ガイド】
- 圧を下げて具体を上げる（短く、軽く、逃げ道）
- 追撃しない、確認で詰めない
`.trim();
}

module.exports = {
  buildHardRules,
  buildMessagePatterns,
  inferTemperatureScore,
  buildTemperatureGuidance,
};
