require("dotenv").config();
const express = require("express");
const line = require("@line/bot-sdk");
const OpenAI = require("openai");

const { buildPaidContent } = require("./paid_templates");
const { generatePaidChatSara } = require("./paid_engine");
const { computePaidScore, formatPaidScoreForUser } = require("./paid_score");

// ★画像解析（vision_ocr.js）
const { analyzeImageToConsultText } = require("./vision_ocr");

const app = express();
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const config = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
};

const client = new line.Client(config);

const userStore = new Map();

function freshSession() {
  return {
    state: "FREE",
    answers: {},
    paid: {
      mode: "CHAT",
      phase: "UNKNOWN",
      history: [],
      lastScore: null,

      // 呼び名（スクショ解釈の安定化）
      // otherToUser: 相手が「あなた」を呼ぶ呼び名
      // userToOther: あなたが「相手」を呼ぶ呼び名
      labels: {
        otherToUser: null,
        userToOther: null,
      },
      flags: {
        askedLabelsOnce: false,
      },

      // 画像解析用
      lastImage: null,
      pendingImage: null, // { messageId, at }
    },
  };
}

function getSession(userId) {
  if (!userStore.has(userId)) {
    userStore.set(userId, freshSession());
  }
  return userStore.get(userId);
}

function tidyLines(s) {
  return (s || "")
    .toString()
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

async function replyText(event, text) {
  return client.replyMessage(event.replyToken, {
    type: "text",
    text: tidyLines(text),
  });
}

function isPaidButtonText(text) {
  const t = (text || "").trim();
  return (
    t === "▶ 続きを見る（有料）" ||
    t === "続きを見る（有料）" ||
    /続き.*有料/.test(t) ||
    (t.includes("▶") && t.includes("有料"))
  );
}

function normalizeArrow(s) {
  return (s || "")
    .replace(/→/g, "->")
    .replace(/＞/g, ">")
    .replace(/＝/g, "=")
    .replace(/：/g, ":")
    .trim();
}

/**
 * 呼び名入力を柔軟にパースする。
 * 受理例：
 * - 相手→あなた=先輩
 * - 相手->自分 は 先輩
 * - 自分→相手=りん
 * - あなた→相手: Aちゃん
 */
function parseLabelSetup(text) {
  const raw = normalizeArrow(text);
  if (!raw) return null;

  // まとめて書かれてるケースもあるので、行ごとに見る
  const lines = raw
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

  const out = { otherToUser: null, userToOther: null };

  const pickValue = (line) => {
    const m = line.match(/(?:=|:|は)\s*(.+)$/);
    return m ? m[1].trim() : null;
  };

  for (const line of lines) {
    const l = line.replace(/\s+/g, " ");

    // 相手 -> (あなた|自分)
    if (/^相手\s*->\s*(あなた|自分)/.test(l)) {
      out.otherToUser = pickValue(l);
      continue;
    }
    if (/^(あなた|自分)\s*<-\s*相手/.test(l)) {
      out.otherToUser = pickValue(l);
      continue;
    }

    // (あなた|自分) -> 相手
    if (/^(あなた|自分)\s*->\s*相手/.test(l)) {
      out.userToOther = pickValue(l);
      continue;
    }
    if (/^相手\s*<-\s*(あなた|自分)/.test(l)) {
      out.userToOther = pickValue(l);
      continue;
    }
  }

  // 値が「未設定」系なら null 扱い
  const clean = (v) => {
    const t = (v || "").trim();
    if (!t) return null;
    if (/^(未設定|なし|ナシ|わからない|不明)$/i.test(t)) return null;
    return t;
  };

  out.otherToUser = clean(out.otherToUser);
  out.userToOther = clean(out.userToOther);

  if (!out.otherToUser && !out.userToOther) return null;
  return out;
}

function isAskToChangeLabels(text) {
  const t = (text || "").trim();
  return /呼び名(変更|セット|設定)/.test(t) || /ニックネーム(変更|設定)/.test(t);
}

// LINE画像を dataURL に変換
async function fetchLineImageAsDataUrl(messageId) {
  const stream = await client.getMessageContent(messageId);
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  const buf = Buffer.concat(chunks);

  // PNG判定（簡易）
  const isPng =
    buf.length >= 8 &&
    buf
      .slice(0, 8)
      .equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  const mime = isPng ? "image/png" : "image/jpeg";

  return `data:${mime};base64,${buf.toString("base64")}`;
}

function isScreenshotPermissionText(text) {
  const t = (text || "").trim();
  return (
    /(スクショ|画像|LINE).*(送ってもいい|貼ってもいい|見せていい)/.test(t) ||
    /サラに.*(送ってもいい|貼ってもいい|見せていい)/.test(t)
  );
}

function shouldTriggerImageParse(text) {
  // 「OK」だけ送っても動くし、追撃文が来ても動く
  const t = (text || "").trim();
  if (!t) return false;
  if (/^(ok|OK|次|つぎ|続けて|続き|見て|みて|解析|お願い)$/.test(t)) return true;
  if (/(送った|貼った|送信|載せた|見てほしい)/.test(t)) return true;
  // pendingImage がある限り、基本は true に寄せる（読めない問題を優先的に潰す）
  return true;
}

function isLikelyGreetingOrSmalltalk(text) {
  const t = (text || "").trim();
  if (!t) return true;
  if (/^(こんにちは|こんばんは|おはよう|やあ|hey|hi|hello|はじめまして|よろしく)(！|。)?$/i.test(t)) return true;
  if (t.length <= 2 && /^(うーん|んー|ん|？|\?)$/.test(t)) return true;
  return false;
}

function isLikelyGoal(text) {
  const t = (text || "").trim();
  if (!t) return false;
  if (/(告白|復縁|距離|仲直り|喧嘩|既読|未読|返信|デート|脈|好き|片思い|別れ)/.test(t)) return true;
  if (/^(告白|復縁|距離縮めたい|距離を縮めたい|仲直り|返信|デート)$/.test(t)) return true;
  return false;
}

function dumpSession(session) {
  return {
    state: session.state,
    answers: session.answers,
    paid: {
      mode: session.paid?.mode,
      phase: session.paid?.phase,
      historyLen: session.paid?.history?.length || 0,
      lastScore: session.paid?.lastScore || null,
      labels: session.paid?.labels || null,
      flags: session.paid?.flags || null,
      lastImage: session.paid?.lastImage || null,
      pendingImage: session.paid?.pendingImage || null,
    },
  };
}

app.post("/webhook", line.middleware(config), async (req, res) => {
  try {
    await Promise.all((req.body.events || []).map(handleEvent));
    res.status(200).end();
  } catch (err) {
    console.error("webhook error", err);
    res.status(200).end();
  }
});

async function handleEvent(event) {
  if (event.type !== "message") return;

  const userId = event.source?.userId;
  if (!userId) return;

  const session = getSession(userId);

  // --------------------------
  // 画像メッセージ：即返信＋キュー保存（ここでは解析しない）
  // --------------------------
  if (event.message?.type === "image") {
    try {
      session.paid.pendingImage = {
        messageId: event.message.id,
        at: Date.now(),
      };

      return replyText(
        event,
        `受け取った💋
いまのスクショ、次のメッセージで読み取るわ。

「OK」って送って。
（個人情報は隠していい）`
      );
    } catch (e) {
      console.error("[IMAGE] enqueue failed:", e);
      return replyText(
        event,
        `画像は受け取ったけど、今ちょっと詰まった💋
もう一回送るか、内容をテキストで1〜3行で貼って。`
      );
    }
  }

  // テキスト以外（スタンプ等）は無視
  if (event.message?.type !== "text") return;

  let text = (event.message.text || "").trim();

  // #dump
  if (text === "#dump") {
    return replyText(event, "```json\n" + JSON.stringify(dumpSession(session), null, 2) + "\n```");
  }

  // リセット
  if (text === "リセット") {
    userStore.delete(userId);
    return replyText(
      event,
      `いらっしゃい💋 サラよ。
ここは恋愛の勝ち筋を作る場所。
状況をそのまま書きなさい。`
    );
  }

  // --------------------------
  // 🔴 スクショ送付確認は即レス（AI呼ばない）
  // --------------------------
  if (isScreenshotPermissionText(text)) {
    return replyText(
      event,
      `送って💋
トークスクショでも文章でもOK。
個人情報は隠していいわよ。`
    );
  }

  // --------------------------
  // ★pendingImage があれば、先に解析してテキスト合流
  // --------------------------
  if (session?.paid?.pendingImage && shouldTriggerImageParse(text)) {
    const pending = session.paid.pendingImage;
    session.paid.pendingImage = null; // 二重処理防止

    try {
      const dataUrl = await fetchLineImageAsDataUrl(pending.messageId);

      // 呼び名ヒントを注入（左右の発言者も明示）
      const labelHintParts = [
        "LINEトークスクショ。右側=相談者（あなた）、左側=相手。",
      ];
      if (session.paid?.labels?.otherToUser) {
        labelHintParts.push(`相手があなたを呼ぶ呼び名: ${session.paid.labels.otherToUser}`);
      }
      if (session.paid?.labels?.userToOther) {
        labelHintParts.push(`あなたが相手を呼ぶ呼び名: ${session.paid.labels.userToOther}`);
      }

      const vision = await analyzeImageToConsultText({
        openai,
        dataUrl,
        hintText: labelHintParts.join("\n"),
      });

      session.paid.lastImage = {
        kind: vision.kind,
        summary: vision.summary || null,
        userIntent: vision.userIntent || null,
        extractedLinesCount: Array.isArray(vision.extractedLines) ? vision.extractedLines.length : 0,
        missingQuestions: Array.isArray(vision.missingQuestions) ? vision.missingQuestions : [],
        at: new Date().toISOString(),
      };

      // 相談文として合流（suggestedUserTextが最優先）
      const synthetic =
        vision.suggestedUserText ||
        tidyLines(
          `（トークスクショ要約）\n${vision.summary || "要約が取れなかった"}\n\n相談：この状況で次の一手を考えて。`
        );

      // ユーザーの追撃文は補足として末尾に添える
      text = tidyLines(`${synthetic}\n\n（補足）${text}`);
    } catch (e) {
      console.error("[IMAGE] analyze failed:", e);
      return replyText(
        event,
        `画像は受け取った。
でも今ちょっと読み取りに失敗したわ💋

スクショの内容を、テキストで1〜3行で貼って。どこが気になる？`
      );
    }
  }

  // --------------------------
  // 無料フェーズ
  // --------------------------
  if (session.state === "FREE") {
    // 雑談/挨拶で進めない（恋愛相談に戻す）
    if (isLikelyGreetingOrSmalltalk(text)) {
      return replyText(
        event,
        `ここは恋愛の話だけね💋
挨拶は受け取った。

いまの恋の状況を1〜2行で。
（例：オンラインの子が気になる／既読無視／復縁したい など）`
      );
    }

    if (!session.answers.problem) {
      session.answers.problem = text;
      return replyText(
        event,
        `うん。
いま一番したいことは？（告白/復縁/距離縮めたい など）`
      );
    }

    if (!session.answers.goal) {
      if (!isLikelyGoal(text)) {
        return replyText(
          event,
          `目的がまだぼんやりね💋
いま一番したいことを、ひとつ選んで。

・告白
・復縁
・距離を縮めたい
・返信を考えたい
・仲直りしたい`
        );
      }
      session.answers.goal = text;
      session.state = "PAID_GATE";
      return replyText(
        event,
        `状況は整理できたわ💋
焦らないで進めるのが大事。

――
ここから先は“設計”になる。
勝ちたいなら、有料でいく💋

（有料に進むなら「▶ 続きを見る（有料）」って送って）`
      );
    }
  }

  // --------------------------
  // 有料ゲート
  // --------------------------
  if (session.state === "PAID_GATE" && isPaidButtonText(text)) {
    session.state = "PAID_CHAT";
    // 呼び名ヒアリングは最初に1回だけ表示（未設定の場合）
    if (session.paid?.flags) session.paid.flags.askedLabelsOnce = true;
    return replyText(event, buildPaidContent(session.answers, session.paid));
  }

  // --------------------------
  // 有料チャット
  // --------------------------
  if (session.state === "PAID_CHAT") {
    // 呼び名変更/セット要求
    if (isAskToChangeLabels(text)) {
      session.paid.flags.askedLabelsOnce = true;
      return replyText(
        event,
        `呼び名セットいくわよ💋
次の形で送って。

相手→あなた=（相手があなたを呼ぶ呼び名）
あなた→相手=（あなたが相手を呼ぶ呼び名）

例：
相手→あなた=先輩
あなた→相手=りん

未設定なら「未設定」でOK。`
      );
    }

    // 呼び名の入力っぽいテキストはここで確実に拾って保存
    const parsedLabels = parseLabelSetup(text);
    if (parsedLabels) {
      session.paid.labels.otherToUser = parsedLabels.otherToUser ?? session.paid.labels.otherToUser;
      session.paid.labels.userToOther = parsedLabels.userToOther ?? session.paid.labels.userToOther;
      session.paid.flags.askedLabelsOnce = true;

      const otherToUser = session.paid.labels.otherToUser || "（未設定）";
      const userToOther = session.paid.labels.userToOther || "（未設定）";
      return replyText(
        event,
        `了解💋 呼び名はこうね。

相手→あなた = ${otherToUser}
あなた→相手 = ${userToOther}

この前提でスクショも会話も読む。続けて。`
      );
    }

    const aiReply = await generatePaidChatSara({
      openai,
      answers: session.answers,
      history: session.paid.history,
      userText: text,
      labels: session.paid.labels,
      lastImage: session.paid.lastImage,
    });

    session.paid.history.push({ role: "user", content: text });
    session.paid.history.push({ role: "assistant", content: aiReply });

    // CHATモードではスコア出さない（paid_score.js 側でも弾くが保険）
    const score = computePaidScore({
      userText: text,
      mode: session.paid.mode,
      phase: session.paid.phase,
      answers: session.answers,
    });

    let finalReply = aiReply;

    // mode=CHATは保存もしない（dumpが汚れない）
    if (score && score.enabled && !/CHAT/i.test(String(session.paid.mode || ""))) {
      session.paid.lastScore = score;
      finalReply += `\n\n――\n${formatPaidScoreForUser(score)}`;
    } else {
      session.paid.lastScore = null;
    }

    // lastImage は1ターン限定（次の発話に引きずらない）
    session.paid.lastImage = null;

    return replyText(event, finalReply);
  }

  return replyText(event, "うまく読めなかったわ💋 もう一回。");
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
