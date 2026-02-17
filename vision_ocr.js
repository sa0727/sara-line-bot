// vision_ocr.js
// LINEの画像（主にトークスクショ）をOpenAI Visionで解析して、相談文として再構成する
// - 画像から「会話ログ」をできるだけ抽出
// - 要点/相談意図/次に必要な情報をJSONで返す

function clamp(n, min, max) {
  const x = Number.isFinite(n) ? n : min;
  return Math.max(min, Math.min(max, x));
}

function safeJsonParse(s) {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

function extractJsonObject(text) {
  const t = (text || "").trim();
  if (!t) return null;

  const fenced = t.match(/```json\s*([\s\S]*?)\s*```/i);
  if (fenced && fenced[1]) {
    const obj = safeJsonParse(fenced[1].trim());
    if (obj) return obj;
  }

  const first = t.indexOf("{");
  const last = t.lastIndexOf("}");
  if (first !== -1 && last !== -1 && last > first) {
    const slice = t.slice(first, last + 1);
    const obj = safeJsonParse(slice);
    if (obj) return obj;
  }
  return null;
}

function tidy(s) {
  return (s || "").replace(/\r\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

function buildSystemPrompt() {
  return (
    "あなたは画像解析アシスタント。日本語。\n" +
    "入力は主にLINEのトークスクリーンショット。\n" +
    "原則：右側の吹き出し=相談者（あなた）、左側の吹き出し=相手。\n" +
    "補足テキストに呼び名があれば、発言者ラベル付けに活用する。\n" +
    "やること：\n" +
    "1) 画像内の会話を可能な限りテキストとして抽出（誰→発言）\n" +
    "2) 恋愛相談としての要点（状況/相手の発言/ユーザーの目的/困ってる点）を要約\n" +
    "3) 相談者がボットに送った体で使える短い『相談文』を生成\n" +
    "注意：読み取れない部分は無理に断定せず、'不明'にする。\n" +
    "出力は必ずJSONのみ。"
  );
}

function buildUserInstruction({ hintText }) {
  const hint = hintText ? `\n補足テキスト（ユーザー入力）：${hintText}\n` : "";
  return (
    "次のJSONだけ返して。\n" +
    hint +
    "{\n" +
    '  "kind": "CHAT_SCREENSHOT" | "OTHER",\n' +
    '  "extractedLines": ["発言者: 発言", "..."],\n' +
    '  "summary": "状況の要約（2〜5行）",\n' +
    '  "userIntent": "相談意図（例：告白後の距離の詰め方、返信の返し方等）",\n' +
    '  "suggestedUserText": "この画像の内容を踏まえて、ボットに送るべき相談文（200〜400文字程度）",\n' +
    '  "missingQuestions": ["追加で聞くべきこと（最大3つ）"]\n' +
    "}\n" +
    "JSON以外の文字は出さない。"
  );
}

async function analyzeImageToConsultText({ openai, dataUrl, hintText = "" }) {
  const model = process.env.VISION_MODEL || process.env.PAID_MODEL || "gpt-4o-mini";
  const temperature = Number.isFinite(Number(process.env.VISION_TEMPERATURE))
    ? clamp(Number(process.env.VISION_TEMPERATURE), 0, 1.0)
    : 0.2;

  const messages = [
    { role: "system", content: buildSystemPrompt() },
    {
      role: "user",
      content: [
        { type: "text", text: buildUserInstruction({ hintText }) },
        { type: "image_url", image_url: { url: dataUrl } },
      ],
    },
  ];

  let raw = "";
  try {
    const resp = await openai.chat.completions.create({
      model,
      messages,
      temperature,
      response_format: { type: "json_object" },
    });
    raw = resp?.choices?.[0]?.message?.content || "";
  } catch (e) {
    const resp = await openai.chat.completions.create({
      model,
      messages,
      temperature,
    });
    raw = resp?.choices?.[0]?.message?.content || "";
  }

  const obj = extractJsonObject(raw) || {};
  const kind = typeof obj.kind === "string" ? obj.kind.trim() : "OTHER";

  const extractedLines = Array.isArray(obj.extractedLines) ? obj.extractedLines.filter(Boolean).slice(0, 40) : [];
  const summary = tidy(typeof obj.summary === "string" ? obj.summary : "");
  const userIntent = tidy(typeof obj.userIntent === "string" ? obj.userIntent : "");
  const suggestedUserText = tidy(typeof obj.suggestedUserText === "string" ? obj.suggestedUserText : "");
  const missingQuestions = Array.isArray(obj.missingQuestions)
    ? obj.missingQuestions.filter(Boolean).slice(0, 3)
    : [];

  return {
    kind: kind === "CHAT_SCREENSHOT" ? "CHAT_SCREENSHOT" : "OTHER",
    extractedLines,
    summary,
    userIntent,
    suggestedUserText,
    missingQuestions,
    rawJson: obj,
  };
}

module.exports = { analyzeImageToConsultText };
