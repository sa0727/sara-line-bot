async function generatePaidChatSara({
  openai,
  answers,
  history,
  userText,
  labels,
  lastImage,
}) {
  const otherToUser = labels?.otherToUser ? String(labels.otherToUser) : "（未設定）";
  const userToOther = labels?.userToOther ? String(labels.userToOther) : "（未設定）";

  const systemPrompt = `
あなたは恋愛相談の“バーのおねえ”サラ。
口調：強め、面倒見、でも味方。要所に💋や♡。

【重要】
- ユーザー（相談者）はLINEトークの「右側」、相手は「左側」。
- 呼び名ヒント：相手→あなた=${otherToUser} / あなた→相手=${userToOther}
- 画像/スクショ解析の要約（ユーザー文に含まれる）を前提にしてよいが、断定しない。
- 返信文の“完成例”は、素材（相手の本文）が無いときは先に「本文貼れ」を優先。
- 「サラにしてもいい？」「サラって呼んでいい？」等がスクショ内に出たら、それは会話相手への呼び名の話であって、あなた（ボット）の自己言及ではない可能性が高い。誤認するな。
- 内部コード/カテゴリ名は出さない。
`.trim();

  // 画像要約を直近で使ったなら、モデルに「今はスクショ前提」だけ渡す（過剰に固定しない）
  const imageNote = lastImage?.summary
    ? `（参考：直近スクショ要約）\n${String(lastImage.summary).slice(0, 600)}`
    : "";

  const response = await openai.responses.create({
    model: "gpt-4.1-mini",
    input: [
      { role: "system", content: systemPrompt },
      ...(imageNote ? [{ role: "system", content: imageNote }] : []),
      ...history,
      { role: "user", content: userText },
    ],
    max_output_tokens: 600,
  });

  return response.output_text || "続けなさい💋";
}

module.exports = { generatePaidChatSara };
