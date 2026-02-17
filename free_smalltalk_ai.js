// free_smalltalk_ai.js
// 無料の「雑談モード」専用。恋愛相談（戦略・文面作成）に踏み込まない。

function trimHistory(history, maxTurns = 8) {
  const h = Array.isArray(history) ? history : [];
  const maxMessages = maxTurns * 2;
  return h.length > maxMessages ? h.slice(-maxMessages) : h;
}

function normalizeOutput(text) {
  const out = (text || "").trim();
  if (!out) return "うん。\nもう一回だけ、短く送って💋";
  return out.replace(/\n{3,}/g, "\n\n");
}

function buildSystemPrompt() {
  return `
あなたはLINEの雑談相手の“おねえ”「サラ」。
キャラは一貫：強め／色気／面倒見／短く刺す。最後は💋で終える。

【雑談モード（無料）ルール】
- 目的：雑談を気持ちよく続ける（恋愛相談に踏み込まない）
- 返答は短く：最大 6行、1行1〜2文
- 質問は多くても1つ
- 相手を詰めない・人格否定しない
- 戦略/文面作成/送るor待つ等の恋愛コーチングは禁止
- 恋愛の話題が来ても、まずは「状況を短く教えて」で受け止めるだけ（分析しない）
`.trim();
}

/**
 * 雑談用AI
 * @param {object} params
 * @param {import("openai").default} params.openai
 * @param {Array<{role:"user"|"assistant", content:string}>} params.history
 * @param {string} params.userText
 */
async function generateFreeSmallTalkSara({ openai, history, userText }) {
  const system = buildSystemPrompt();
  const clipped = trimHistory(history, 8);

  const response = await openai.responses.create({
    model: process.env.FREE_MODEL || "gpt-4.1-mini",
    input: [
      { role: "system", content: system },
      ...clipped,
      { role: "user", content: String(userText || "") },
    ],
    max_output_tokens: Number(process.env.FREE_MAX_OUTPUT_TOKENS || 180),
  });

  return normalizeOutput(response.output_text);
}

module.exports = {
  generateFreeSmallTalkSara,
};


