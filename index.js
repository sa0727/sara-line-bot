require("dotenv").config();
const express = require("express");
const line = require("@line/bot-sdk");
const OpenAI = require("openai");

const { buildPaidContent } = require("./paid_templates");
const { generatePaidChatSara, trimHistory } = require("./paid_engine");
const { analyzeImageToConsultText } = require("./vision_ocr");

// 既存のプロジェクトにある前提（あれば使う）
let computePaidScore = null;
let formatPaidScoreForUser = null;
try {
  ({ computePaidScore, formatPaidScoreForUser } = require("./paid_score"));
} catch {
  // paid_score.js が無い or 読めない環境でも動くように（CHATでは使わない想定）
}

let detectImportantEvent = null;
let updatePaidSummaryIfNeeded = null;
try {
  ({ detectImportantEvent, updatePaidSummaryIfNeeded } = require("./paid_memory"));
} catch {
  // paid_memory.js が無い環境でも動くように
}

const app = express();
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const config = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
};
const client = new line.Client(config);

const userStore = new Map();

// 同一ユーザーのイベント処理を直列化（画像→OK の順序崩れ対策）
const userLocks = new Map();
function runWithUserLock(userId, fn) {
  const prev = userLocks.get(userId) || Promise.resolve();
  const next = prev.catch(() => {}).then(fn);
  userLocks.set(
    userId,
    next.finally(() => {
      if (userLocks.get(userId) === next) userLocks.delete(userId);
    })
  );
  return next;
}

function freshSession() {
  return {
    state: "FREE",
    answers: {},
    paid: {
      mode: "CHAT",
      phase: "UNKNOWN",
      history: [],
      lastScore: null,

      // 長期メモ（要約）
      summary: "",
      turns: 0,
      lastImportantEventAtTurn: 0,

      // 呼び名（任意・不特定多数対応）
      // calledByOther: 相手→自分 の呼び方（例：先輩）
      // calledByUser: 自分→相手 の呼び方（例：Aちゃん）
      labels: {
        calledByOther: "",
        calledByUser: "",
      },

      // ★追加：呼び名を「画像後に1回だけ」促すためのフラグ
      labelsAskedAfterImage: false,

      // 画像解析用
      pendingImage: null, // { messageId, at }
      lastImage: null, // 1ターン限定で model に渡す
      lastImageCache: null, // デバッグ用：最後に読んだ画像の記録
      lastImageActiveOnce: false, // true の時、次の返信生成後に lastImage を消す
    },
  };
}

function getSession(userId) {
  if (!userStore.has(userId)) userStore.set(userId, freshSession());
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

function labelOrDefault(v, fallback) {
  const s = (v || "").trim();
  return s ? s : fallback;
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

function isScreenshotPermissionText(text) {
  const t = (text || "").trim();
  return (
    /(スクショ|画像|LINE).*(送ってもいい|貼ってもいい|見せていい)/.test(t) ||
    /サラに.*(送ってもいい|貼ってもいい|見せていい)/.test(t)
  );
}

function shouldTriggerImageParse(text) {
  const t = (text || "").trim();
  if (!t) return false;
  if (/^(ok|OK|次|つぎ|続けて|続き|見て|みて|解析|お願い)$/.test(t)) return true;
  if (/(送った|貼った|送信|載せた|見てほしい)/.test(t)) return true;
  return true;
}

async function fetchLineImageAsDataUrl(messageId) {
  const stream = await client.getMessageContent(messageId);
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  const buf = Buffer.concat(chunks);

  const isPng =
    buf.length >= 8 &&
    buf
      .slice(0, 8)
      .equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  const mime = isPng ? "image/png" : "image/jpeg";
  return `data:${mime};base64,${buf.toString("base64")}`;
}

function dumpSession(session) {
  return {
    state: session.state,
    answers: session.answers,
    paid: {
      mode: session.paid?.mode,
      phase: session.paid?.phase,
      labels: session.paid?.labels,
      labelsAskedAfterImage: session.paid?.labelsAskedAfterImage,
      historyLen: session.paid?.history?.length || 0,
      summaryLen: (session.paid?.summary || "").length,
      turns: session.paid?.turns || 0,
      lastScore: session.paid?.lastScore || null,
      pendingImage: session.paid?.pendingImage || null,
      lastImage: session.paid?.lastImage || null,
      lastImageCache: session.paid?.lastImageCache || null,
      lastImageActiveOnce: session.paid?.lastImageActiveOnce || false,
    },
  };
}

// 無料は「受け止め＋浅い整理＋方向性（案）＋NG」まで（具体例文や深掘りは有料）
function buildFreeLiteAdvice({ problem, goal }) {
  const g = (goal || "").trim();
  let direction = "まずは相手の温度と前提（関係性/距離感）を揃える。";
  let ng = "いきなり重い確認・詰問・長文連投。";

  if (/告白/.test(g)) {
    direction = "告白は『気持ち』より先に“関係の土台”を作るのが勝ち筋♡";
    ng = "雰囲気任せの突然告白／返事を急かす／相手の負担を盛る言い方。";
  } else if (/復縁/.test(g)) {
    direction = "復縁は『連絡再開→小さな成功体験→会う』の順で積むの♡";
    ng = "いきなり謝罪爆撃／未練長文／相手の罪悪感に頼る動き。";
  } else if (/距離|仲良く|近づ/.test(g)) {
    direction = "距離を縮めるなら『会話の頻度』より“安心感の一貫性”よ💋";
    ng = "反応に一喜一憂して態度がブレる／駆け引きで試す。";
  }

  return tidyLines(`
いい、無料で言えるのは“ここまで”ね💋

・いまの状況：${problem ? problem : "（未入力）"}
・狙い：${goal ? goal : "（未入力）"}

【軽い助言（案）】
・方向性：${direction}
・まずやること：相手の反応が分かる材料を集める（直近のやり取り／相手の言い回し／既読未読）
・NG：${ng}

ここから先は“設計”に入る。
勝ちたいなら、有料でいくわ♡

（進むなら「▶ 続きを見る（有料）」って送って）
  `);
}

/**
 * 呼び名パース（不特定多数対応）
 * 例：
 *  相手→自分=先輩
 *  自分→相手=Aちゃん
 *  相手->自分: 先輩
 *  自分->相手 未設定
 */
function parseLabelsFromText(text) {
  const t = (text || "").trim();
  if (!t) return null;

  const wantChange = /^(呼び名変更|呼び名リセット|ラベル変更)$/i.test(t);

  const out = { calledByOther: "", calledByUser: "", wantChange };

  const norm = t.replace(/→/g, "->").replace(/＝/g, "=").replace(/：/g, ":");

  // 相手->自分
  {
    const m = norm.match(/相手\s*->\s*自分\s*[:=]\s*([^\n\r]+)/);
    if (m && m[1]) out.calledByOther = m[1].trim();
  }
  // 自分->相手
  {
    const m = norm.match(/自分\s*->\s*相手\s*[:=]\s*([^\n\r]+)/);
    if (m && m[1]) out.calledByUser = m[1].trim();
  }

  const clean = (s) => {
    const v = (s || "").trim();
    if (!v) return "";
    if (/^(未設定|なし|特にない|ない)$/i.test(v)) return "";
    return v.slice(0, 20);
  };

  out.calledByOther = clean(out.calledByOther);
  out.calledByUser = clean(out.calledByUser);

  if (!out.calledByOther && !out.calledByUser && !out.wantChange) return null;
  return out;
}

function formatQuoteTurns(quoteTurns, labels) {
  const q = Array.isArray(quoteTurns) ? quoteTurns.filter(Boolean).slice(0, 2) : [];
  if (!q.length) return "";

  // 表示ラベル：USERは「相手があなたを呼ぶ呼び名」、OTHERは「あなたが相手を呼ぶ呼び名」
  const userLabel = labelOrDefault(labels?.calledByOther, "あなた");
  const otherLabel = labelOrDefault(labels?.calledByUser, "相手");

  const fmt = (x) => {
    const sp =
      x.speaker === "USER" ? userLabel : x.speaker === "OTHER" ? otherLabel : "不明";
    return `${sp}『${String(x.text || "").trim()}』`;
  };

  if (q.length === 1) return fmt(q[0]);
  return `${fmt(q[0])} / ${fmt(q[1])}`;
}

app.post("/webhook", line.middleware(config), async (req, res) => {
  try {
    const events = req.body.events || [];
    for (const ev of events) {
      const uid = ev?.source?.userId;
      if (!uid) continue;
      await runWithUserLock(uid, () => handleEvent(ev));
    }
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

  // 画像：即返信＋pendingImage保存（解析はしない）
  if (event.message?.type === "image") {
    session.paid.pendingImage = { messageId: event.message.id, at: Date.now() };
    return replyText(
      event,
      `受け取った💋
今のスクショ、次のメッセージで読み取る。

「OK」って送って。
（個人情報は隠していい）`
    );
  }

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
      `いらっしゃい💋
サラのバーへようこそ。

恋愛の話、ここでは逃がさない♡
まず状況をそのまま吐きな。`
    );
  }

  // 「スクショ送ってもいい？」系は即レス（AIに投げない）
  if (isScreenshotPermissionText(text)) {
    return replyText(
      event,
      `送って💋
トークスクショでも文章でもOK。
個人情報は隠していい♡

貼ったら「OK」って言いな。こっちで読む。`
    );
  }

  // 呼び名変更コマンド（任意）
  if (/^呼び名変更$/i.test(text) && session.state === "PAID_CHAT") {
    session.paid.labels.calledByOther = "";
    session.paid.labels.calledByUser = "";
    // 画像後に一回聞くフラグも戻す（=また促して良い）
    session.paid.labelsAskedAfterImage = false;
    return replyText(
      event,
      `いいわ💋 呼び名をリセットした。
もう一回だけ送って。

相手→自分=（例：先輩）
自分→相手=（例：Aちゃん）

未設定でもOK。`
    );
  }

  // PAID_CHAT 中に呼び名セットを拾う（未設定はスキップ）
  if (session.state === "PAID_CHAT") {
    const parsed = parseLabelsFromText(text);
    if (parsed) {
      if (parsed.wantChange) {
        session.paid.labels.calledByOther = "";
        session.paid.labels.calledByUser = "";
        session.paid.labelsAskedAfterImage = false;
      }
      if (parsed.calledByOther) session.paid.labels.calledByOther = parsed.calledByOther;
      if (parsed.calledByUser) session.paid.labels.calledByUser = parsed.calledByUser;

      const onlyLabelLike =
        /^(\s*(相手|自分)\s*(->|→)\s*(自分|相手)\s*[:=].*)+$/m.test(
          text.replace(/→/g, "->").replace(/＝/g, "=").replace(/：/g, ":")
        );

      if (onlyLabelLike) {
        const me = labelOrDefault(session.paid.labels.calledByOther, "あなた");
        const them = labelOrDefault(session.paid.labels.calledByUser, "相手");
        return replyText(
          event,
          `了解♡ 呼び名セットした。\n${me} / ${them} でいくわ💋\n\n続けて、素材（相手の返信本文 or スクショ or 既読未読）を出しな。`
        );
      }
      // ラベル以外の相談も入ってるなら、そのまま通常処理へ続行
    }
  }

  // pendingImage 合流（次のテキストで解析）
  if (session?.paid?.pendingImage && shouldTriggerImageParse(text)) {
    const pending = session.paid.pendingImage;
    session.paid.pendingImage = null;

    try {
      const dataUrl = await fetchLineImageAsDataUrl(pending.messageId);

      const userLabel = labelOrDefault(session.paid.labels.calledByOther, "あなた");
      const otherLabel = labelOrDefault(session.paid.labels.calledByUser, "相手");

      const vision = await analyzeImageToConsultText({
        openai,
        dataUrl,
        hintText: `LINEのトークスクショ。重要：右側の吹き出し＝相談者（USER）、左側の吹き出し＝相手（OTHER）。右(USER)は「${userLabel}」、左(OTHER)は「${otherLabel}」として扱って。`,
      });

      const lastImageObj = {
        kind: vision.kind,
        speakerConvention: vision.speakerConvention || "RIGHT_IS_USER",
        summary: vision.summary || null,
        quoteTurns: Array.isArray(vision.quoteTurns) ? vision.quoteTurns.slice(0, 2) : [],
        ambiguousRefs: Array.isArray(vision.ambiguousRefs) ? vision.ambiguousRefs.slice(0, 5) : [],
        userIntent: vision.userIntent || null,
        extractedLinesCount: Array.isArray(vision.extractedLines) ? vision.extractedLines.length : 0,
        dialogueTurnsCount: Array.isArray(vision.dialogueTurns) ? vision.dialogueTurns.length : 0,
        missingQuestions: Array.isArray(vision.missingQuestions) ? vision.missingQuestions : [],
        at: new Date().toISOString(),
      };

      // 1ターン限定で使う & デバッグ用キャッシュ
      session.paid.lastImage = lastImageObj;
      session.paid.lastImageCache = lastImageObj;
      session.paid.lastImageActiveOnce = true;

      const synthetic =
        vision.suggestedUserText ||
        tidyLines(
          `（トークスクショ要約）
${vision.summary || "要約が取れなかった"}

相談：この状況で次の一手を考えて。`
        );

      const quoteLabel = formatQuoteTurns(vision.quoteTurns, session.paid.labels);
      const quoteLine = quoteLabel
        ? `拾ったセリフ：${quoteLabel}`
        : `拾ったセリフ：${userLabel}『（短いセリフ）』/${otherLabel}『（短いセリフ）』`;

      const imageMeta = vision.summary
        ? `【画像あり】最初に必ず2行：\n1) 読めた要点：${String(vision.summary).slice(
            0,
            140
          )}\n2) ${quoteLine}\nそして “右＝${userLabel}、左＝${otherLabel}” の前提で答える。文脈が曖昧なら設計の前に確認質問を1〜2個だけ。`
        : `【画像あり】最初に必ず2行：\n1) 読めた要点：〜\n2) ${quoteLine}\nそして “右＝${userLabel}、左＝${otherLabel}” の前提で答える。文脈が曖昧なら確認質問を1〜2個だけ。`;

      text = tidyLines(`${imageMeta}\n${synthetic}\n\n（補足）${text}`);
    } catch (e) {
      console.error("[IMAGE] analyze failed:", e);
      return replyText(
        event,
        `画像は受け取った。で、今ちょっと読み取りがコケた💋

悪いけど、スクショの要点をテキストで1〜3行で貼って♡
どこが一番引っかかってる？（嫉妬/温度差/告白/返信待ち など）`
      );
    }
  }

  // ====== FREE ======
  if (session.state === "FREE") {
    if (!session.answers.problem) {
      session.answers.problem = text;
      return replyText(
        event,
        `ふぅん。状況は掴んだ♡\n\nで、いま一番したいことは何？（告白/復縁/距離縮めたい など）`
      );
    }

    if (!session.answers.goal) {
      session.answers.goal = text;
      session.state = "PAID_GATE";
      return replyText(
        event,
        buildFreeLiteAdvice({
          problem: session.answers.problem,
          goal: session.answers.goal,
        })
      );
    }
  }

  // ====== PAID_GATE ======
  if (session.state === "PAID_GATE" && isPaidButtonText(text)) {
    session.state = "PAID_CHAT";
    return replyText(event, buildPaidContent(session.answers));
  }

  // ====== PAID_CHAT ======
  if (session.state === "PAID_CHAT") {
    const recentHistory = trimHistory(
      session.paid.history,
      Number(process.env.PAID_CHAT_HISTORY_MAX || 20)
    );

    const aiReply = await generatePaidChatSara({
      openai,
      answers: session.answers,
      summary: session.paid.summary,
      history: recentHistory,
      userText: text,
      mode: session.paid.mode,
      phase: session.paid.phase,
      lastImage: session.paid.lastImage, // ★1ターン限定
      labels: session.paid.labels,
    });

    session.paid.history.push({ role: "user", content: text });
    session.paid.history.push({ role: "assistant", content: aiReply });
    session.paid.turns = Number(session.paid.turns || 0) + 1;

    // ★ lastImage 1ターン限定化：返信生成が終わったら消す（cacheは残す）
    if (session.paid.lastImageActiveOnce) {
      session.paid.lastImageActiveOnce = false;
      session.paid.lastImage = null;
    }

    // ★ 画像後の「呼び名」促しは、未設定の時だけ1回だけ
    let finalReply = aiReply;
    const noLabels =
      !String(session.paid.labels.calledByOther || "").trim() &&
      !String(session.paid.labels.calledByUser || "").trim();

    // “画像を読んだ直後のターン”でのみ促す（lastImageCacheが最近更新された前提で軽く）
    // 厳密に「直後」判定したい場合は lastImageCache.at を使ってもOK。
    if (noLabels && !session.paid.labelsAskedAfterImage) {
      // labelsAskedAfterImage は「一度でも促したら true」
      // ここでは「画像を使ったターン」だけ促したいので、直前に pendingImage合流が起きた時は lastImageCache が更新されている。
      // ただしユーザーが画像無しで進めても、促しは出ない。
      const justHadImage = !!session.paid.lastImageCache && !!session.paid.lastImageCache.at;
      if (justHadImage) {
        session.paid.labelsAskedAfterImage = true;
        finalReply += tidyLines(`
        
――
ちなみに💋 呼び名セットするとスクショの精度が一気に上がる。
任意でいいから、よかったらこれだけ送って♡

相手→自分=（例：先輩）
自分→相手=（例：Aちゃん）

未設定でも進める。`);
      }
    }

    // メモリ更新（あれば）
    try {
      if (detectImportantEvent && updatePaidSummaryIfNeeded) {
        const importantEventHit = detectImportantEvent(text);
        await updatePaidSummaryIfNeeded({
          openai,
          session,
          userText: text,
          aiText: aiReply,
          importantEventHit,
        });
      }
    } catch {
      // noop
    }

    // スコア（CHATでは出さない方針を堅牢化）
    try {
      if (computePaidScore && formatPaidScoreForUser) {
        const score = computePaidScore({
          userText: text,
          mode: session.paid.mode,
          phase: session.paid.phase,
          answers: session.answers,
        });

        if (score && score.enabled && !/CHAT/i.test(String(session.paid.mode || ""))) {
          session.paid.lastScore = score;
          finalReply += `\n\n――\n${formatPaidScoreForUser(score)}`;
        } else {
          session.paid.lastScore = null;
        }
      } else {
        session.paid.lastScore = null;
      }
    } catch {
      session.paid.lastScore = null;
    }

    return replyText(event, finalReply);
  }

  return replyText(event, "うまく読めなかったわ💋 もう一回。");
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
