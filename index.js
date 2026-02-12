require("dotenv").config();
const OpenAI = require("openai");

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const express = require("express");
const line = require("@line/bot-sdk");

const { buildFreeAnalysis } = require("./free_templates");
const { applyFreeNLU, nextMissingQuestion } = require("./free_nlu");

// paid系（分割版）
const { PaidPhase, updatePaidPhaseFromUserText, adviceSignature } = require("./paid_state");
const { generatePaidChatSara, extractQuotedMessage } = require("./paid_engine");
const { detectImportantEvent, updatePaidSummaryIfNeeded } = require("./paid_memory");
const {
  buildHardRules,
  buildMessagePatterns,
  inferTemperatureScore,
  buildTemperatureGuidance,
} = require("./paid_policy");
const { applyPaidHeuristics, extractWithMiniAI, extractPlanFromAi } = require("./paid_extractors");

const app = express();

const config = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
};

const client = new line.Client(config);

/**
 * メモリ保存（開発用）
 */
const userStore = new Map();

/**
 * 状態定義
 */
const State = Object.freeze({
  IDLE: "IDLE",

  // （旧）ボタン式フロー（残してOK：保険）
  READ_Q1_LAST_MET: "READ_Q1_LAST_MET",
  READ_Q2_LAST_SENDER: "READ_Q2_LAST_SENDER",
  READ_Q3_SILENCE: "READ_Q3_SILENCE",
  READ_Q4_GOAL: "READ_Q4_GOAL",
  READ_Q5_FEAR: "READ_Q5_FEAR",

  // ★無料：自由入力でスロット収集
  FREE_COLLECT: "FREE_COLLECT",

  // 無料分析完了
  FREE_ANALYSIS_DONE: "FREE_ANALYSIS_DONE",

  // 有料
  PAID_INPUT: "PAID_INPUT",
  PAID_CHAT: "PAID_CHAT",
});

function getUserId(event) {
  return event?.source?.userId || "anonymous";
}

function createFreshSession() {
  return {
    state: State.IDLE,
    answers: {
      problem: null,
      lastMet: null,
      lastSender: null,
      silence: null,
      goal: null,
      fear: null,

      relationshipStage: null,
      partnerSpeed: null,
      partnerType: null,
    },
    paid: {
      summary: null,
      history: [],

      phase: PaidPhase.UNKNOWN,
      turns: 0,
      lastSentText: null,
      lastAdviceSig: null,
      lastClarifyQ: null,
      lastImportantEventAtTurn: 0,
      plan: { action: null, timing: null, draft: null, ng: [] },
    },
  };
}

function getSession(userId) {
  if (!userStore.has(userId)) {
    userStore.set(userId, createFreshSession());
  }
  return userStore.get(userId);
}

function resetSession(userId) {
  userStore.set(userId, createFreshSession());
}

/**
 * LINE Quick Reply
 */
function quickReply(items) {
  return {
    items: items.map((label) => ({
      type: "action",
      action: { type: "message", label, text: label },
    })),
  };
}

async function replyText(event, text, qrLabels = null) {
  const message = { type: "text", text };
  if (qrLabels?.length) message.quickReply = quickReply(qrLabels);
  return client.replyMessage(event.replyToken, message);
}

function normalize(text) {
  return (text || "").trim();
}

/**
 * サラの相槌（おねえ口調）
 */
function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function saraAck(kind = "normal") {
  const normal = [
    "うん、分かった。\n焦ると手を間違えるから、ここは一個ずつ整理するわよ💋",
    "OK…状況は見えてきた。\nでも今は結論を急がない。順番にいくわ💋",
    "大丈夫、まだ詰んでない。\nちゃんと整理すれば立て直せるから、続けて💋",
    "うん。\n不安で暴走しやすい局面。だから“確認”ね💋",
  ];

  const ask = [
    "よし。\nここ外すと全部ズレる。ちゃんと答えて💋",
    "分かった。\n次が肝。ここ誤魔化す人ほどこじらせるのよ💋",
    "うんうん。\n次、ここ聞くわ。ここで判断が決まる💋",
  ];

  return kind === "ask" ? pick(ask) : pick(normal);
}

/**
 * 入口メニュー
 */
async function sendStartMenu(event) {
  return replyText(event, "いらっしゃい💋\nどれで悩んでる？", [
    "既読無視",
    "脈あり診断（準備中）",
    "告白（準備中）",
    "復縁（準備中）",
  ]);
}

/**
 * 無料：既読無視（自由入力開始）
 */
async function startReadFlow(event, session) {
  session.answers.problem = "既読無視";
  session.state = State.FREE_COLLECT;

  return replyText(
    event,
    "あ〜…既読無視ね。\nそれ、心が削られるやつ。\n\n状況を一気に書いて。\n例）「会ってない。既読3日。会いたい。重いと思われるのが怖い」\n短くてOKよ💋"
  );
}

/**
 * 有料開始：入力促し
 */
async function handlePaywallContent(event, session) {
  session.state = State.PAID_INPUT;
  session.paid.phase = PaidPhase.UNKNOWN;

  return replyText(
    event,
    "ここから有料よ💋\n\n今の状況をそのまま書いて。\n例：\n・返信きた\n・既読ついたけど返事ない\n・まだ送ってない\n\nそのまま送って。",
    null
  );
}

/**
 * （旧）ボタン式フロー：残してOK（保険）
 */
async function handleReadFlow(event, session, text) {
  const t = normalize(text);

  if (session.state === State.READ_Q1_LAST_MET) {
    session.answers.lastMet = t;
    session.state = State.READ_Q2_LAST_SENDER;
    return replyText(event, "Q2｜最後に送ったのは誰？", ["自分", "相手"]);
  }

  if (session.state === State.READ_Q2_LAST_SENDER) {
    session.answers.lastSender = t;
    session.state = State.READ_Q3_SILENCE;
    return replyText(event, "Q3｜既読無視の期間は？", ["数時間", "1日", "3日以上"]);
  }

  if (session.state === State.READ_Q3_SILENCE) {
    session.answers.silence = t;
    session.state = State.READ_Q4_GOAL;
    return replyText(event, "Q4｜ゴールは？", ["会いたい", "仲直りしたい", "付き合いたい", "見極めたい"]);
  }

  if (session.state === State.READ_Q4_GOAL) {
    session.answers.goal = t;
    session.state = State.READ_Q5_FEAR;
    return replyText(event, "Q5｜いちばん怖いのは？", [
      "嫌われる",
      "他に好きな人がいる",
      "どうでもいいと思われる",
      "重いと思われる",
      "分からない",
    ]);
  }

  if (session.state === State.READ_Q5_FEAR) {
    session.answers.fear = t;
    session.state = State.FREE_ANALYSIS_DONE;
    const analysis = buildFreeAnalysis(session.answers);
    return replyText(event, analysis, ["▶ 続きを見る（有料）", "今日はここまで", "メニュー"]);
  }

  return replyText(event, "いったんメニューに戻る？", ["メニュー"]);
}

/**
 * Webhook
 */
app.get("/", (req, res) => res.send("LINE bot server running"));

app.post("/webhook", line.middleware(config), async (req, res) => {
  try {
    await Promise.all(req.body.events.map(handleEvent));
    res.status(200).send("OK");
  } catch (err) {
    console.error("Webhook error:", err);
    res.status(500).end();
  }
});

/**
 * ざっくり「方針まとめ」出したいトリガー（任意）
 */
function shouldRecapPlan(text) {
  const t = (text || "").trim();
  return /どうする|どうしたら|どうしよ|まだ送ってない|送れてない|迷ってる|送る？|送っていい|いまから/.test(t);
}

function formatPlanRecap(plan) {
  if (!plan) return null;
  const parts = [];
  if (plan.action) {
    parts.push(
      `方針：${
        plan.action === "send" ? "送る" : plan.action === "wait" ? "待つ" : plan.action === "confirm" ? "確認" : "様子見"
      }`
    );
  }
  if (plan.timing) parts.push(`タイミング：${plan.timing}`);
  if (plan.draft) parts.push(`文面：\n「${plan.draft}」`);
  if (Array.isArray(plan.ng) && plan.ng.length) parts.push(`やっちゃダメ：${plan.ng.slice(0, 3).join("／")}`);
  return parts.join("\n");
}

/**
 * 有料処理（PAID_INPUT / PAID_CHAT 共通）
 */
async function runPaidTurn(event, session, text, isFirstTurn) {
  // 1) ルールベース更新（paid側）
  applyPaidHeuristics(text, session.answers, session);

  // 念のため phase 更新（重複でもOK）
  updatePaidPhaseFromUserText(session, text);

  // 返信きた局面では plan をリセット（古い指示で迷子防止）
  if (session.paid.phase === PaidPhase.AFTER_REPLY) {
    session.paid.plan = { action: null, timing: null, draft: null, ng: [] };
  }

  const importantHit = detectImportantEvent(text);

  session.paid.history.push({ role: "user", content: text });

  // 2) ミニAI補助：必要なときだけ（情報が欠けてる場合）
  const needMini =
    !session.answers.relationshipStage ||
    !session.answers.partnerSpeed ||
    !session.answers.partnerType ||
    !session.answers.lastSender;

  if (needMini) {
    const extracted = await extractWithMiniAI({
      openai,
      userText: text,
      answers: session.answers,
    });

    if (extracted) {
      for (const [k, v] of Object.entries(extracted)) {
        if (v == null) continue;
        if (session.answers[k] == null || String(session.answers[k]).trim() === "") {
          session.answers[k] = v;
        }
      }
      // 反映後にもう一回 phase 更新（lastSender が埋まる想定）
      updatePaidPhaseFromUserText(session, text);
    }
  }

  // 3) policy組み立て（本番=evalと同一）
  const hardRules = buildHardRules({ answers: session.answers, phase: session.paid.phase });
  const patterns = buildMessagePatterns();

  const tempScore = inferTemperatureScore({
    userText: text,
    answers: session.answers,
    phase: session.paid.phase,
  });
  const temperatureGuidance = buildTemperatureGuidance(tempScore);

  // 4) 本体AI
  const aiText = await generatePaidChatSara({
    openai,
    answers: session.answers,
    history: session.paid.history,
    userText: text,
    paidSummary: session.paid.summary,
    paidMeta: {
      phase: session.paid.phase,
      lastSentText: session.paid.lastSentText,
      lastClarifyQ: session.paid.lastClarifyQ,
      lastAdviceSig: session.paid.lastAdviceSig,
      hardRules,
      patterns,
      temperatureGuidance,
    },
  });

  // 5) plan抽出（運用ログ/リキャップ用）
  const plan = await extractPlanFromAi({ openai, aiText });
  if (plan) session.paid.plan = plan;

  session.paid.history.push({ role: "assistant", content: aiText });

  // 6) ループ防止ログ更新
  const quoted = extractQuotedMessage(aiText);
  if (quoted) session.paid.lastSentText = quoted;

  // 確認質問っぽい短文を記録（連発防止の材料）
  if ((/\?$|？$/.test(aiText) && aiText.length <= 160) || /それ、あたし/.test(aiText)) {
    session.paid.lastClarifyQ = aiText;
  } else {
    session.paid.lastClarifyQ = null;
  }

  const shortFacts = `${session.answers.relationshipStage || ""}|${session.answers.partnerSpeed || ""}|${
    session.answers.partnerType || ""
  }|${session.answers.goal || ""}`;
  session.paid.lastAdviceSig = adviceSignature(session.paid.phase, quoted || "", shortFacts);

  session.paid.turns += 1;

  // 7) summary 自動更新
  await updatePaidSummaryIfNeeded({
    openai,
    session,
    userText: text,
    aiText,
    importantEventHit: importantHit,
  });

  // state 遷移
  if (isFirstTurn) session.state = State.PAID_CHAT;

  // （任意）ユーザーが「どうする？」系なら、直近planを短く追記（使い勝手UP）
  let extra = "";
  if (shouldRecapPlan(text) && session.paid.plan) {
    const recap = formatPlanRecap(session.paid.plan);
    if (recap) extra = `\n\n――\n${recap}`;
  }

  if (isFirstTurn) {
    return replyText(
      event,
      aiText + extra + "\n\n送ったら結果（相手の返事 or 状況）をそのまま貼って。次の一手出す💋",
      ["メニュー"]
    );
  }

  return replyText(event, aiText + extra, ["メニュー"]);
}

async function handleEvent(event) {
  if (event.type !== "message" || event.message.type !== "text") return;

  const userId = getUserId(event);
  const session = getSession(userId);
  const text = normalize(event.message.text);

  // 共通コマンド（完全一致だけ）
  if (text === "リセット") {
    resetSession(userId);
    return sendStartMenu(event);
  }
  if (text === "メニュー") {
    resetSession(userId);
    return sendStartMenu(event);
  }

  // 有料：最初の入力
  if (session.state === State.PAID_INPUT) {
    try {
      return await runPaidTurn(event, session, text, true);
    } catch (e) {
      console.error("PAID AI ERROR:", e?.status, e?.code, e?.message);
      return replyText(event, "ごめん、今ちょっと詰まった。もう一回送って💋");
    }
  }

  // 有料：会話継続
  if (session.state === State.PAID_CHAT) {
    try {
      return await runPaidTurn(event, session, text, false);
    } catch (e) {
      console.error("PAID CHAT ERROR:", e?.status, e?.code, e?.message);
      return replyText(event, "ごめん、今ちょっと詰まった。もう一回送って💋");
    }
  }

  // 無料：自由入力
  if (session.state === State.FREE_COLLECT) {
    const updates = applyFreeNLU(text, session.answers);
    Object.assign(session.answers, updates);

    const q = nextMissingQuestion(session.answers);
    if (q) {
      return replyText(event, `${saraAck("ask")}\n${q}`);
    }

    session.state = State.FREE_ANALYSIS_DONE;
    const analysis = buildFreeAnalysis(session.answers);
    return replyText(event, analysis, ["▶ 続きを見る（有料）", "今日はここまで", "メニュー"]);
  }

  // 開始前
  if (session.state === State.IDLE) {
    if (text === "既読無視") return startReadFlow(event, session);
    return sendStartMenu(event);
  }

  // 無料分析後
  if (session.state === State.FREE_ANALYSIS_DONE) {
    if (text === "▶ 続きを見る（有料）") return handlePaywallContent(event, session);
    if (text === "今日はここまで") {
      resetSession(userId);
      return replyText(event, "OK。\n今日はここまで。\nまた来なさい💋", ["メニュー"]);
    }
    return replyText(event, "どっちにする？", ["▶ 続きを見る（有料）", "今日はここまで", "メニュー"]);
  }

  // 旧フロー保険
  return handleReadFlow(event, session, text);
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
