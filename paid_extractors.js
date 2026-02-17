// paid_extractors.js
const { applyFreeNLU } = require("./free_nlu");
// const { updatePaidPhaseFromUserText } = require("./paid_state"); // ←もう使わないので削除

function normalize(text) {
  return (text || "").trim();
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
 * lastSender の揺れを矯正（"ユーザー" 等を "自分" に寄せる）
 */
function normalizeLastSender(v) {
  if (v == null) return null;
  const s = String(v).trim();
  if (!s) return null;

  if (s === "自分" || s === "相手") return s;
  if (s === "ユーザー" || s === "私" || s === "わたし") return "自分";

  // 英語系・その他
  if (/user/i.test(s)) return "自分";
  if (/partner|other/i.test(s)) return "相手";

  return null;
}

/**
 * paid側のルールベース補助
 * - free_nlu から拾えるものは拾う（silence/goal 等）
 * - lastSender を安定させる（相手/自分）
 *
 * ★重要：ここでは phase / ignoreStreak を更新しない
 *        （同一ターンで複数回走って二重加算する事故を防ぐ）
 *        phase更新は index.js 側で1回だけ行う。
 */
function applyPaidHeuristics(userText, answers, session) {
  const updates = applyFreeNLU(userText, answers);
  Object.assign(answers, updates);

  const t = normalize(userText);

  // lastSender の推定（ユーザーが言ってる意味を優先）
  if (!answers.lastSender) {
    if (/相手が送ってきた|相手から|向こうから|返信きた|返事きた|って返ってきた/.test(t)) answers.lastSender = "相手";
    if (/私が送った|自分が送った|送った|送信した|送ってある|昨日送った/.test(t)) answers.lastSender = "自分";
  } else {
    // 変な値なら矯正
    const fixed = normalizeLastSender(answers.lastSender);
    if (fixed) answers.lastSender = fixed;
  }
}

/**
 * 抽出専用ミニAI：ユーザー文からスロット補助
 * - 出力が壊れても tryParseJsonObject で拾う
 * - lastSender の揺れをここでも矯正
 */
async function extractWithMiniAI({ openai, userText, answers }) {
  const system = `
あなたは恋愛相談ログの情報抽出専用。
出力はJSONオブジェクト1個のみ。余計な文章・説明・コードフェンスは禁止。
不確実なら null。
`.trim();

  const prompt = `
次のユーザー文から、埋められる項目だけ抽出してJSONで返して。
キーはこの中だけ：
relationshipStage, partnerSpeed, partnerType, lastMet, silence, goal, fear, lastSender

lastSender は必ず "自分" か "相手" のどちらか。分からなければ null。

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
      model: process.env.MINI_EXTRACT_MODEL || "gpt-4.1-mini",
      max_output_tokens: Number(process.env.MINI_EXTRACT_MAX_TOKENS || 220),
      input: [
        { role: "system", content: system },
        { role: "user", content: prompt },
      ],
    });

    const raw = (resp.output_text || "").trim();
    const json = tryParseJsonObject(raw);
    if (!json) return null;

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
    for (const k of allowed) {
      if (!(k in json)) continue;
      cleaned[k] = json[k];
    }

    // lastSender 矯正
    if ("lastSender" in cleaned) {
      const fixed = normalizeLastSender(cleaned.lastSender);
      cleaned.lastSender = fixed || null;
    }

    return cleaned;
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
  if (/送る(のが|で|。|！)|送って/.test(t)) action = "send";
  else if (/待つ(のが|で|。|！)|今は待/.test(t) || /追い(ライン|LINE)は(まだ|やめ)/.test(t)) action = "wait";
  else if (/\?$|？$/.test(t) && /送|待/.test(t)) action = "confirm";
  else action = "observe";

  // timing 推定（雑でOK：短め）
  const timingMatch = t.match(/(今日|明日|明後日|2日後|今夜|今晩|夜|夕方|昼|朝)[^\n。]{0,20}/);
  const timing = timingMatch ? timingMatch[0].slice(0, 40) : null;

  // draft 推定：「」の最後を拾う
  const quotes = [...t.matchAll(/「([^」]{1,140})」/g)];
  const draft = quotes.length ? quotes[quotes.length - 1][1].trim().slice(0, 120) : null;

  // ng 推定：箇条書きっぽい行を拾う
  const ng = [];
  const lines = t.split("\n");
  for (const line of lines) {
    const m = line.match(/^\s*[・\-*]\s*(.{1,28})/);
    if (m) {
      ng.push(m[1].trim());
      if (ng.length >= 3) break;
    }
  }

  return { action, timing, draft, ng };
}

/**
 * AI出力から「判断フラグ」を抽出（保存用）
 */
async function extractPlanFromAi({ openai, aiText }) {
  const system = `
あなたは出力解析専用。
出力は厳密なJSONオブジェクト1個のみ。
余計な文章、説明、コードフェンスは禁止。
`.trim();

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
      model: process.env.PLAN_EXTRACT_MODEL || "gpt-4.1-mini",
      max_output_tokens: Number(process.env.PLAN_EXTRACT_MAX_TOKENS || 200),
      input: [
        { role: "system", content: system },
        { role: "user", content: prompt },
      ],
    });

    const raw = (resp.output_text || "").trim();
    const json = tryParseJsonObject(raw);

    if (!json) return derivePlanHeuristic(aiText);

    const cleaned = {
      action: ["send", "wait", "confirm", "observe"].includes(json.action) ? json.action : null,
      timing: json.timing ? String(json.timing).slice(0, 40) : null,
      draft: json.draft ? String(json.draft).slice(0, 120) : null,
      ng: Array.isArray(json.ng) ? json.ng.map((x) => String(x).slice(0, 28)).slice(0, 3) : [],
    };

    if (!cleaned.action) return derivePlanHeuristic(aiText);
    return cleaned;
  } catch {
    return derivePlanHeuristic(aiText);
  }
}

module.exports = {
  applyPaidHeuristics,
  extractWithMiniAI,
  extractPlanFromAi,
};


