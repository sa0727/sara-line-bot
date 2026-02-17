// paid_engine.js

function trimHistory(history, maxMessages = 20) {
  const arr = Array.isArray(history) ? history : [];
  const cleaned = arr
    .filter(
      (m) =>
        m &&
        (m.role === "user" || m.role === "assistant") &&
        typeof m.content === "string"
    )
    .map((m) => ({ role: m.role, content: m.content }));

  if (cleaned.length <= maxMessages) return cleaned;
  return cleaned.slice(-maxMessages);
}

function hasAmbiguousPersons(text) {
  const t = String(text || "");
  return /(先輩|友達|同期|後輩|元カレ|元カノ|誰か|あの人|その人|別の人|他の人)/.test(t);
}

function labelOrDefault(v, fallback) {
  const s = (v || "").trim();
  return s ? s : fallback;
}

function formatQuoteTurnsForModel(quoteTurns, labels) {
  const q = Array.isArray(quoteTurns) ? quoteTurns.filter(Boolean).slice(0, 2) : [];
  if (!q.length) return "（なし）";

  const userLabel = labelOrDefault(labels?.calledByOther, "あなた");
  const otherLabel = labelOrDefault(labels?.calledByUser, "相手");

  const fmt = (x) => {
    const sp = x.speaker === "USER" ? userLabel : x.speaker === "OTHER" ? otherLabel : "不明";
    return `${sp}『${String(x.text || "").trim()}』`;
  };

  if (q.length === 1) return fmt(q[0]);
  return `${fmt(q[0])} / ${fmt(q[1])}`;
}

async function generatePaidChatSara({
  openai,
  answers,
  summary,
  history,
  userText,
  mode,
  phase,
  lastImage,
  labels,
}) {
  const imageSummary = lastImage?.summary ? String(lastImage.summary) : "";
  const quoteTurns = Array.isArray(lastImage?.quoteTurns) ? lastImage.quoteTurns.slice(0, 2) : [];
  const ambiguousRefs = Array.isArray(lastImage?.ambiguousRefs)
    ? lastImage.ambiguousRefs.filter(Boolean).slice(0, 5)
    : [];
  const missingQs = Array.isArray(lastImage?.missingQuestions)
    ? lastImage.missingQuestions.filter(Boolean).slice(0, 3)
    : [];

  const userLabel = labelOrDefault(labels?.calledByOther, "あなた"); // 相手→自分
  const otherLabel = labelOrDefault(labels?.calledByUser, "相手"); // 自分→相手

  const systemPrompt = `
あなたは恋愛相談バーのママ「サラ」。
舞台は深夜のカウンター。相手は“客”。口調は強め・色気・現実。

【絵文字の使い方（重要）】
・💋 は “区切り” と “覚悟の一言” に。
・♡/❤ は “受け止め” と “背中を押す一言” に。
・自然に、でも少なすぎない（目安：1〜3個）。

【呼び名（任意だが優先）】
・相談者（右側/USER）：${userLabel}
・相手（左側/OTHER）：${otherLabel}
※以降、引用や説明ではこの呼び名を優先して使う。

【人格】
・断定口調で手綱を握る。甘やかさない。でも必ず味方♡
・勝ち筋（戦略/言い方/順序/間合い）を短く出す。
・無駄に長文にしない。1〜2手先まで。

【画像の読み方（左右の固定）】
・スクショは「右＝${userLabel}（相談者/USER）」「左＝${otherLabel}（相手/OTHER）」。
・この前提を崩さない。曖昧な時だけ、確認を1〜2問。

【サラ誤認防止（重要）】
・ユーザーが「サラ」と言った時、それは “このボット（あなた自身）” を指す可能性が高い。
  相手の呼び名だと決め打ちしない。
・「サラにしてもいい？」「サラに相談してもいい？」等は、ユーザー→あなたへの問いかけ。
  その場合は普通に受けて会話する（雑談/相談の許可を出す）。
・相手の呼び名としての「サラ」だと断定できない場合は、1問だけ確認する。

【ズレ対策】
・人物関係は決め打ち禁止。「先輩/友達/誰か」など曖昧参照が出たら、まず1問だけ確認してから設計。
・曖昧さが残る状態で、嫉妬・ライバル前提の戦略を組まない。

【会話ルール】
・内部コード名や内部分類は出さない。
・一般知識は不確かな時は「わからない」と言う。
・材料が無いなら先に素材回収。
・画像を読めた場合は、冒頭に必ず次の2行：
  1) 読めた要点：〜
  2) 拾ったセリフ：${userLabel}『…』/${otherLabel}『…』（quoteTurns があるなら必ず使う）
・最後は「次に送るもの」を1行で指定。

【雑談許可】
・有料CHATでは雑談OK。雑談を無理に戦略に戻さない。
・ただし恋愛の相談に戻せるなら、最後に一言で戻す。

【無料/有料の境界】
・有料では具体的な言い回し（例文）、手順、タイミング、優先順位まで“設計”していい。
・ただし材料（相手本文/既読未読/状況）が無いなら、先に素材回収。

【固定情報（answers）】
${JSON.stringify(answers || {}, null, 2)}

【現在フェーズ】${phase || "UNKNOWN"}
【現在モード】${mode || "CHAT"}

【長期メモ（要約）】
${(summary || "（なし）").slice(0, 900)}

【直近画像要約】
${imageSummary ? imageSummary.slice(0, 650) : "（なし）"}

【直近画像：拾ったセリフ（左右ラベル済み）】
${formatQuoteTurnsForModel(quoteTurns, labels)}

【直近画像：曖昧な参照】
${ambiguousRefs.length ? ambiguousRefs.join(" / ") : "（なし）"}

【直近画像：追加で聞くべきこと（最大3）】
${missingQs.length ? missingQs.map((q) => `・${q}`).join("\n") : "（なし）"}
`.trim();

  const needClarify =
    (!!imageSummary && hasAmbiguousPersons(imageSummary)) ||
    ambiguousRefs.length > 0 ||
    missingQs.length > 0;

  const guardNudge = needClarify
    ? "【注意】文脈が曖昧。最初に確認質問を1〜2個だけしてから設計に入ること。確認が取れるまでは、具体例文や細かい手順に踏み込まない。"
    : "";

  const response = await openai.responses.create({
    model: process.env.PAID_CHAT_MODEL || "gpt-4.1-mini",
    input: [
      { role: "system", content: systemPrompt },
      ...(guardNudge ? [{ role: "system", content: guardNudge }] : []),
      ...trimHistory(history, Number(process.env.PAID_CHAT_HISTORY_MAX || 20)),
      { role: "user", content: userText },
    ],
    max_output_tokens: Number(process.env.PAID_CHAT_MAX_TOKENS || 700),
  });

  return response.output_text || "続けなさい💋";
}

module.exports = { generatePaidChatSara, trimHistory };
