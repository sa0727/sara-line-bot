// paid_extractors.js
const { applyFreeNLU } = require("./free_nlu");
const { updatePaidPhaseFromUserText } = require("./paid_state");

function normalize(text) {
  return (text || "").trim();
}

function applyPaidHeuristics(userText, answers, session) {
  const updates = applyFreeNLU(userText, answers);
  Object.assign(answers, updates);

  const t = normalize(userText);

  if (!answers.lastSender) {
    if (/相手が送ってきた|相手から|向こうから|返信きた/.test(t)) answers.lastSender = "相手";
    if (/私が送った|送った|送信した/.test(t)) answers.lastSender = "自分";
  }

  updatePaidPhaseFromUserText(session, userText);
}

/**
 * 抽出専用ミニAI：ユーザー文からスロット補助（既存）
 */
async function extractWithMiniAI({ openai, userText, answers }) {
  const system = `あなたは恋愛相談ログの情報抽出専用。出力はJSON 1個のみ。余計な文章禁止。`.trim();

  const prompt = `
次のユーザー文から、埋められる項目だけ抽出してJSONで返して。未確実なら null。
キーはこの中だけ：
relationshipStage, partnerSpeed, partnerType, lastMet, silence, goal, fear, lastSender

ユーザー文：
${userText}

現在の既知：
${JSON.stringify(
    {
      lastMet: answers.lastMet,
      silence: answers.silence,
      goal: answers.goal,
      fear: answers.fear,
      relationshipStage: answers.relationshipStage,
      partnerSpeed: answers.partnerSpeed,
      partnerType: answers.partnerType,
      lastSender: answers.lastSender,
    },
    null,
    2
  )}
`.trim();

  try {
    const resp = await openai.responses.create({
      model: "gpt-4.1-mini",
      max_output_tokens: 220,
      input: [
        { role: "system", content: system },
        { role: "user", content: prompt },
      ],
    });

    const raw = (resp.output_text || "").trim();
    const json = JSON.parse(raw);

    const allowed = [
      "relationshipStage",
      "partnerSpeed",
      "partnerType",
      "lastMet",
      "silence",
      "goal",
      "fear",
      "lastSender",
    ];

    const cleaned = {};
    for (const k of allowed) if (k in json) cleaned[k] = json[k];
    return cleaned;
  } catch {
    return null;
  }
}

/**
 * JSONの頑丈パース：文章が混ざっても最初の { ... } を拾って parse する
 */
function tryParseJsonObject(rawText) {
  if (!rawText) return null;
  const t = String(rawText).trim();

  // まず素直に
  try {
    return JSON.parse(t);
  } catch {}

  // 次に、最初の { ... } を抜き出して parse
  const m = t.match(/\{[\s\S]*\}/);
  if (!m) return null;

  try {
    return JSON.parse(m[0]);
  } catch {
    return null;
  }
}

/**
 * plan fallback：AI抽出が壊れたときの保険
 */
function derivePlanHeuristic(aiText) {
  const t = String(aiText || "");

  // action 推定
  let action = null;
  if (/今は送る|送るのが正解|送って/.test(t)) action = "send";
  else if (/今は待つ|待つのが正解|送るのはやめ|送らない/.test(t)) action = "wait";
  else if (/\?$|？$/.test(t) && /送|待/.test(t)) action = "confirm";
  else action = "observe";

  // timing 推定（雑でOK：文字数短め）
  const timingMatch = t.match(/(今日|明日|明後日|2日後|今夜|夜|夕方|昼|朝)[^\n。]{0,20}/);
  const timing = timingMatch ? timingMatch[0].slice(0, 40) : null;

  // draft 推定：「」の最後を拾う
  const quotes = [...t.matchAll(/「([^」]{1,140})」/g)];
  const draft = quotes.length ? quotes[quotes.length - 1][1].trim().slice(0, 120) : null;

  // ng 推定：箇条書きの・ を拾う
  const ng = [];
  const lines = t.split("\n");
  for (const line of lines) {
    const m = line.match(/^\s*[・\-*]\s*(.{1,24})/);
    if (m) {
      ng.push(m[1].trim());
      if (ng.length >= 3) break;
    }
  }

  return { action, timing, draft, ng };
}

/**
 * (1) AI出力から「判断フラグ」を抽出（保存用）
 */
async function extractPlanFromAi({ openai, aiText }) {
  const system = `あなたは出力解析専用。出力は厳密なJSON 1個のみ。余計な文章、説明、コードフェンス禁止。`.trim();

  const prompt = `
次のテキストから、方針と具体を抽出してJSONで返して。
キーは action,timing,draft,ng のみ。
action は send/wait/confirm/observe のいずれか。
timing は短く（例：明日20時、今日夜、2日後の夜）。
draft は相手に送る文面がある場合のみ（1〜2文）。なければ null。
ng は最大3つ。なければ []。

テキスト：
${aiText}
`.trim();

  try {
    const resp = await openai.responses.create({
      model: "gpt-4.1-mini",
      max_output_tokens: 200,
      input: [
        { role: "system", content: system },
        { role: "user", content: prompt },
      ],
    });

    const raw = (resp.output_text || "").trim();
    const json = tryParseJsonObject(raw);

    if (!json) {
      // JSONが取れなかったら fallback
      return derivePlanHeuristic(aiText);
    }

    const cleaned = {
      action: ["send", "wait", "confirm", "observe"].includes(json.action) ? json.action : null,
      timing: json.timing ? String(json.timing).slice(0, 40) : null,
      draft: json.draft ? String(json.draft).slice(0, 120) : null,
      ng: Array.isArray(json.ng) ? json.ng.map((x) => String(x).slice(0, 24)).slice(0, 3) : [],
    };

    // actionが空なら fallback
    if (!cleaned.action) return derivePlanHeuristic(aiText);

    return cleaned;
  } catch {
    // 抽出API自体が落ちたら fallback
    return derivePlanHeuristic(aiText);
  }
}

module.exports = {
  applyPaidHeuristics,
  extractWithMiniAI,
  extractPlanFromAi,
};
