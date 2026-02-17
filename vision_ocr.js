// vision_ocr.js
// LINEトークスクショをOpenAI Visionで解析し、右＝USER / 左＝OTHER を構造化して返す

function clamp(n, min, max) {
  const x = Number.isFinite(n) ? n : min;
  return Math.max(min, Math.min(max, x));
}

function tidy(s) {
  return (s || "")
    .toString()
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
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

function uniqCompact(arr, max = 2) {
  const out = [];
  const seen = new Set();
  for (const x of Array.isArray(arr) ? arr : []) {
    const s = tidy(String(x || "")).replace(/\s+/g, " ").trim();
    if (!s) continue;
    if (seen.has(s)) continue;
    seen.add(s);
    out.push(s);
    if (out.length >= max) break;
  }
  return out;
}

function normalizeSpeaker(sp) {
  const s = String(sp || "").toUpperCase().trim();
  if (s === "USER" || s === "ME" || s === "RIGHT") return "USER";
  if (s === "OTHER" || s === "THEM" || s === "LEFT") return "OTHER";
  return "UNKNOWN";
}

function sanitizeLineText(s) {
  const t = tidy(String(s || "")).replace(/\s+/g, " ").trim();
  return t;
}

function buildSystemPrompt() {
  return `
あなたは画像解析アシスタント。日本語。
入力は主にLINEのトークスクリーンショット。

【最重要：左右の規約】
- 右側の吹き出し＝相談者（USER）
- 左側の吹き出し＝相手（OTHER）
この規約は絶対に守る。迷ったらUNKNOWNにする。

やること：
1) 画像内の会話を可能な限りテキスト抽出（左右に基づく speaker 付き）
2) 恋愛相談としての要点（状況/相手の発言/ユーザーの目的/困ってる点）を要約
3) 相談者がボットに送った体で使える短い相談文を生成
4) 固有フレーズを2つだけ引用（quoteTurns：speaker付き）。短く、個人情報は伏せる
5) 人物関係が曖昧なら ambiguousRefs に列挙（例：先輩/友達）
6) 文脈が曖昧なら missingQuestions（最大3）

出力は必ずJSONのみ。
`.trim();
}

function buildUserInstruction({ hintText }) {
  const hint = hintText ? `\n補足：${hintText}\n` : "";
  return `
次のJSONだけ返して。JSON以外の文字は出さない。
${hint}
{
  "kind": "CHAT_SCREENSHOT" | "OTHER",
  "speakerConvention": "RIGHT_IS_USER",
  "dialogueTurns": [{"speaker":"USER"|"OTHER"|"UNKNOWN","text":"発言"}],
  "extractedLines": ["USER: 発言", "OTHER: 発言", "..."],
  "summary": "状況の要約（2〜5行）",
  "quoteTurns": [{"speaker":"USER"|"OTHER","text":"短いセリフ"}],
  "ambiguousRefs": ["先輩","友達"],
  "userIntent": "相談意図（例：距離の縮め方、返信の返し方等）",
  "suggestedUserText": "ボットに送る相談文（200〜450文字）",
  "missingQuestions": ["追加で聞くべきこと（最大3つ）"]
}
`.trim();
}

function guessAmbiguousRefs(text) {
  const t = String(text || "");
  const labels = ["先輩", "友達", "同期", "後輩", "元カレ", "元カノ", "あの人", "その人", "別の人", "他の人", "誰か"];
  const hit = [];
  for (const w of labels) if (t.includes(w)) hit.push(w);
  return uniqCompact(hit, 5);
}

function pickQuoteTurnsFromDialogue(dialogueTurns) {
  const cands = [];
  for (const t of Array.isArray(dialogueTurns) ? dialogueTurns : []) {
    const sp = normalizeSpeaker(t?.speaker);
    const text = sanitizeLineText(t?.text);
    if (sp !== "USER" && sp !== "OTHER") continue;
    if (!text) continue;
    if (text.length < 6) continue;
    if (text.length > 60) continue;

    // 露骨なID/URL/メール/電話っぽいものは引用候補から除外
    if (/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/.test(text)) continue;
    if (/https?:\/\//.test(text)) continue;
    if (/(\d{2,4}[- ]?\d{2,4}[- ]?\d{3,4})/.test(text)) continue;

    cands.push({ speaker: sp, text });
  }

  // USERとOTHERを1つずつ優先（左右理解を強く見せるため）
  const userOne = cands.find((x) => x.speaker === "USER");
  const otherOne = cands.find((x) => x.speaker === "OTHER");
  const out = [];
  if (userOne) out.push(userOne);
  if (otherOne) out.push(otherOne);

  for (const x of cands) {
    if (out.length >= 2) break;
    if (out.some((y) => y.speaker === x.speaker && y.text === x.text)) continue;
    out.push(x);
  }

  return out.slice(0, 2);
}

async function analyzeImageToConsultText({ openai, dataUrl, hintText = "" }) {
  const model = process.env.VISION_MODEL || "gpt-4o-mini";
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
  } catch {
    const resp = await openai.chat.completions.create({ model, messages, temperature });
    raw = resp?.choices?.[0]?.message?.content || "";
  }

  const obj = extractJsonObject(raw) || {};

  const kind = typeof obj.kind === "string" ? obj.kind.trim() : "OTHER";
  const speakerConvention = "RIGHT_IS_USER";

  const dialogueTurns = Array.isArray(obj.dialogueTurns)
    ? obj.dialogueTurns
        .map((x) => ({
          speaker: normalizeSpeaker(x?.speaker),
          text: sanitizeLineText(x?.text),
        }))
        .filter((x) => x.text)
        .slice(0, 80)
    : [];

  const extractedLines = Array.isArray(obj.extractedLines)
    ? obj.extractedLines.map((s) => tidy(String(s || ""))).filter(Boolean).slice(0, 80)
    : dialogueTurns.map((t) => `${t.speaker}: ${t.text}`).slice(0, 80);

  const summary = tidy(typeof obj.summary === "string" ? obj.summary : "");
  const userIntent = tidy(typeof obj.userIntent === "string" ? obj.userIntent : "");
  const suggestedUserText = tidy(typeof obj.suggestedUserText === "string" ? obj.suggestedUserText : "");

  const ambiguousRefsRaw = Array.isArray(obj.ambiguousRefs) ? obj.ambiguousRefs.filter(Boolean) : [];
  const ambiguousRefs = uniqCompact(ambiguousRefsRaw, 5);

  const missingQuestions = Array.isArray(obj.missingQuestions)
    ? obj.missingQuestions
        .filter(Boolean)
        .slice(0, 3)
        .map((x) => tidy(String(x)))
    : [];

  const quoteTurnsRaw = Array.isArray(obj.quoteTurns) ? obj.quoteTurns : [];
  let quoteTurns = quoteTurnsRaw
    .map((x) => ({
      speaker: normalizeSpeaker(x?.speaker),
      text: sanitizeLineText(x?.text),
    }))
    .filter((x) => (x.speaker === "USER" || x.speaker === "OTHER") && x.text)
    .slice(0, 2);

  if (!quoteTurns.length) {
    quoteTurns = pickQuoteTurnsFromDialogue(dialogueTurns);
  }

  const autoAmb = ambiguousRefs.length
    ? ambiguousRefs
    : guessAmbiguousRefs([summary, ...extractedLines].join("\n"));

  return {
    kind: kind === "CHAT_SCREENSHOT" ? "CHAT_SCREENSHOT" : "OTHER",
    speakerConvention,
    dialogueTurns,
    extractedLines,
    summary,
    quoteTurns,
    ambiguousRefs: autoAmb,
    userIntent,
    suggestedUserText,
    missingQuestions,
    rawJson: obj,
  };
}

module.exports = { analyzeImageToConsultText };
