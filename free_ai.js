// free_ai.js
// 無料AI：
// - SMALLTALK：雑談を自然に返す（恋愛に勝手に誘導しない）
// - ANALYSIS：浅く整理＋次の一手1つ＋NG（最大3）
// - 温度スコア（0-100）計算
// - 履歴は最大3件のみ渡す
//
// 追加：
// - SMALLTALKは強制的に「2〜4行」構成（ただし重複行は潰す）
// - サラ崩れ語尾を後処理で強く潰す
// - \\n を \n に戻す（改行が表示されない事故対策）

function clamp(n, min, max) {
  const x = Number.isFinite(n) ? n : min;
  return Math.max(min, Math.min(max, x));
}

function labelFromScore(score) {
  const s = clamp(score, 0, 100);
  if (s >= 67) return "HIGH";
  if (s >= 34) return "MID";
  return "LOW";
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

function normalizeHistory3(history3) {
  const h = Array.isArray(history3) ? history3 : [];
  return h
    .filter((m) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
    .slice(-3)
    .map((m) => ({ role: m.role, content: m.content }));
}

function hasRomanceSignal(text) {
  const t = (text || "").trim();
  return /(好き|気になる|彼|彼女|元カレ|元カノ|デート|会いたい|会う|会える|告白|復縁|既読|未読|返信|無視|喧嘩|ブロック|LINE|ライン|不安|つらい|辛い|仲良くなりたい|遊び|誘|ご飯|ごはん|飲み|一緒に行きたい|気になる子|気になる人|好きな人)/.test(
    t
  );
}

function isDraftRequest(text) {
  const t = (text || "").trim();
  return /(文章|文面|LINE|DM|メッセージ|送る文|添削|言い方|なんて送|どう送|例文|テンプレ|コピペ)/.test(t);
}

function isSexualText(text) {
  const t = (text || "").trim();
  return /(オナニー|自慰|性欲|セックス|えっち|エロ|ちんこ|まんこ|勃起|フェラ|潮|射精)/i.test(t);
}

function buildSafeRedirectReply() {
  return (
    "その話はここでは深掘りしないわ💋\n" +
    "線引きは守りなさい。\n\n" +
    "話題変える。\n" +
    "いま暇つぶしでハマってること、何？（ゲームでもOK）"
  );
}

function buildSystemPrompt(mode) {
  const base =
    "あなたは『恋愛相談bot：サラ』。日本語。\n" +
    "キャラ：強めのおねえ。断定的に手綱を握る。でも根っこは味方。\n" +
    "口調ルール：毎回どこかに💋。『しなさい』『教えなさい』『いい？』『黙って聞きな』を軸。\n" +
    "絶対禁止：若者口調（例：じゃん／〜だよね？／準備しててね／頼もしいじゃん／最高じゃない！）。\n" +
    "禁止：『どう思う？』で投げる（代わりに『答えなさい』『どっちにする？』）。\n" +
    "禁止：クイズを“複数出す宣言”。クイズは必ず1問ずつ。\n" +
    "質問は原則1つだけ。返答は短め（目安：2〜6行＋必要なら空行）。\n" +
    "下品/露骨な性的話題は深掘りしない。境界線を示して話題転換。\n" +
    "出力は必ずJSONのみ。";

  if (mode === "SMALLTALK") {
    return (
      base +
      "\n\n【雑談モード】\n" +
      "重要：恋愛に勝手に誘導しない。恋愛の話題へ進めるのはユーザーが恋愛シグナルを出した時だけ。\n" +
      "構成を守れ（2〜4行、基本3行）：\n" +
      "1行目：受け止め\n" +
      "2行目：短い一言\n" +
      "3行目：質問1つ\n"
    );
  }

  return (
    base +
    "\n\n【無料分析モード】\n" +
    "無料の範囲は『浅く整理＋次の一手1つ＋NG（最大3つ）』まで。\n" +
    "文面の“完成稿”は作らない。必要なら“入口の1行”だけ。\n" +
    "構成：\n" +
    "1) 状況整理（1〜2行）\n" +
    "2) 次の一手（必ず1つ）\n" +
    "3) NG（最大3つ）\n" +
    "最後に質問はしない（無料は2問で終了）。\n\n" +
    "【出力フォーマット】\n" +
    "必ず次の3ブロックだけで返す（順番固定）。\n" +
    "・整理：〜\n" +
    "・次の一手：〜\n" +
    "・NG：①… ②… ③…（最大3つ）\n" +
    "※区切り線（――）や、課金誘導文は書かない。"
  );
}

function buildUserInstruction({ mode, userText, answers, romanceSignal, draftRequest }) {
  const a = answers || {};
  const facts = {
    category: a.category || null,
    problemSnippet: a.problemSnippet || null,
    silence: a.silence || null,
    goal: a.goal || null,
    breakupAgo: a.breakupAgo || null,
    breakupReason: a.breakupReason || null,
    meetCount: a.meetCount || null,
    partnerTemp: a.partnerTemp || null,
    contactStatus: a.contactStatus || null,
    fightGoal: a.fightGoal || null,
    relationshipStage: a.relationshipStage || null,
  };

  return (
    `mode=${mode}\n` +
    `romanceSignal=${romanceSignal}\n` +
    `draftRequest=${draftRequest}\n` +
    `userText=${userText}\n` +
    `knownFacts=${JSON.stringify(facts)}\n\n` +
    "【必須】次のJSONだけ返して。\n" +
    "{\n" +
    '  "replyText": "ユーザーへ返す本文（サラ口調。SMALLTALKは2〜4行）",\n' +
    '  "tempScore": 0-100の整数,\n' +
    '  "tempLabel": "LOW" | "MID" | "HIGH"\n' +
    "}\n\n" +
    "JSON以外の文字は出さない。"
  );
}

function restoreNewlines(s) {
  return (s || "").replace(/\\n/g, "\n");
}

function normalizeLineBreaks(s) {
  return (s || "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function postPolishSara(text) {
  let s = restoreNewlines((text || "").trim());
  if (!s) return s;

  s = s.replace(/じゃん/gi, "よ");
  s = s.replace(/だよね？/g, "よ？");
  s = s.replace(/だよね\?/g, "よ？");
  s = s.replace(/準備しててね/gi, "準備はいい？");
  s = s.replace(/頼もしい/gi, "いいじゃない");
  s = s.replace(/最高じゃない！/gi, "いいじゃない💋");
  s = s.replace(/おっ、/g, "ふうん。");
  s = s.replace(/気分転換しよ！/g, "気分転換しな💋");

  s = s.replace(/どう思う？/g, "どっちにする？");
  s = s.replace(/どう思う\?/g, "どっちにする？");

  s = s.replace(/いくつかクイズ出す[^。\n]*[。\n]?/g, "");
  s = s.replace(/クイズ出すから[^。\n]*[。\n]?/g, "");

  if (!/💋/.test(s)) s += "💋";

  return normalizeLineBreaks(s);
}

function postPolishSaraByMode(text, mode) {
  let s = postPolishSara(text);

  // 区切り線を無料側で出さない（ブリッジ側が出す）
  s = s.replace(/^――+$/gm, "").trim();

  if (mode === "ANALYSIS") {
    // 最後の行が質問で終わっていたら削る（無料は質問しない）
    const lines = s.split("\n").map((x) => x.trim()).filter(Boolean);
    while (lines.length && /[？\?]$/.test(lines[lines.length - 1])) {
      lines.pop();
    }
    s = lines.join("\n").trim();
  }

  if (!/💋/.test(s)) s += "💋";
  return normalizeLineBreaks(s);
}

function dedupeLines(lines) {
  const out = [];
  for (const line of lines) {
    const l = (line || "").trim();
    if (!l) continue;
    if (out.length && out[out.length - 1] === l) continue;
    out.push(l);
  }
  return out;
}

function enforceSmallTalkFormat(reply) {
  const s = normalizeLineBreaks(reply);
  if (!s) return s;

  let lines = dedupeLines(s.split("\n"));

  if (lines.length === 1) {
    lines = [lines[0], "ふうん。続けな💋", "で、いま何してる？"];
  } else if (lines.length === 2) {
    if (!/[？\?]$/.test(lines[1])) lines.push("で、いま何してる？");
  } else if (lines.length > 4) {
    lines = lines.slice(0, 4);
  }

  const hasQ = lines.some((l) => /[？\?]$/.test(l));
  if (!hasQ) {
    if (lines.length >= 4) lines[lines.length - 1] = "で、いま何してる？";
    else lines.push("で、いま何してる？");
  }

  return lines.join("\n");
}

async function generateFreeAI({ openai, userText, answers, history3, mode }) {
  const t = (userText || "").trim();
  const a = answers || {};

  const romanceSignal = hasRomanceSignal(t);
  const draftRequest = isDraftRequest(t);

  if (isSexualText(t)) {
    return { replyText: buildSafeRedirectReply(), tempScore: 0, tempLabel: "LOW" };
  }

  const system = buildSystemPrompt(mode);
  const instruction = buildUserInstruction({
    mode,
    userText: t,
    answers: a,
    romanceSignal,
    draftRequest,
  });

  const input = [{ role: "system", content: system }].concat(normalizeHistory3(history3)).concat([{ role: "user", content: instruction }]);

  const response = await openai.responses.create({
    model: process.env.FREE_MODEL || "gpt-4.1-mini",
    input,
    max_output_tokens: Number(process.env.FREE_MAX_OUTPUT_TOKENS || 350),
  });

  const raw = (response.output_text || "").trim();
  const obj = extractJsonObject(raw) || {};

  const replyText = normalizeLineBreaks(String(obj.replyText || "").trim()) || "うまく読めなかったわ。もう一回書きなさい💋";

  let tempScore = Number.isFinite(obj.tempScore) ? Math.round(obj.tempScore) : 50;
  tempScore = clamp(tempScore, 0, 100);
  const tempLabel = obj.tempLabel && /^(LOW|MID|HIGH)$/.test(String(obj.tempLabel)) ? obj.tempLabel : labelFromScore(tempScore);

  // 後処理：サラ口調と改行を整える
  const polished = postPolishSaraByMode(replyText, mode);

  if (mode === "SMALLTALK") {
    return {
      replyText: enforceSmallTalkFormat(polished),
      tempScore,
      tempLabel,
    };
  }

  return { replyText: polished, tempScore, tempLabel };
}

module.exports = {
  generateFreeAI,
};


